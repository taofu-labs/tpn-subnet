# Shared HTTP client with timeouts, retries, and connection pooling
# Prevents indefinite hangs when Node.js container is unresponsive

import asyncio
import aiohttp
import bittensor as bt
from random import uniform
from typing import Optional, Any, Dict


# Timeout configuration (in seconds)
DEFAULT_TIMEOUT = 30
CONNECT_TIMEOUT = 10
CHALLENGE_TIMEOUT = 60  # Longer for compute-intensive tasks

# Retry configuration
MAX_RETRIES = 3
INITIAL_DELAY = 1.0
BACKOFF_MULTIPLIER = 2.0
MAX_DELAY = 30.0
JITTER_MAX = 1.0  # Random jitter to prevent thundering herd


class HTTPClientError( Exception ):
    """Raised when HTTP request fails after all retries"""
    pass


def _get_timeout( timeout_seconds: Optional[float] = None ) -> aiohttp.ClientTimeout:
    """Create aiohttp timeout configuration"""
    total = timeout_seconds or DEFAULT_TIMEOUT
    return aiohttp.ClientTimeout(
        total=total,
        connect=CONNECT_TIMEOUT
    )


async def _retry_with_backoff( func, *args, max_retries: int = MAX_RETRIES, **kwargs ):
    """
    Execute async function with exponential backoff retry logic.
    Raises HTTPClientError after all retries exhausted.
    """
    last_error = None
    delay = INITIAL_DELAY

    # Attempt the request up to max_retries times, backing off exponentially on failure
    for attempt in range( max_retries ):
        try:
            return await func( *args, **kwargs )
        except ( aiohttp.ClientError, asyncio.TimeoutError, ValueError ) as e:
            # ValueError catches json.JSONDecodeError (its parent class)
            last_error = e
            if attempt < max_retries - 1:
                # Add jitter to prevent thundering herd
                jitter = uniform( 0, JITTER_MAX )
                wait_time = min( delay + jitter, MAX_DELAY )
                bt.logging.warning(
                    f"HTTP request failed (attempt { attempt + 1 }/{ max_retries }): { e }. "
                    f"Retrying in { wait_time:.1f }s..."
                )
                await asyncio.sleep( wait_time )
                delay *= BACKOFF_MULTIPLIER
            else:
                bt.logging.error(
                    f"HTTP request failed after { max_retries } attempts: { e }"
                )

    raise HTTPClientError( f"Request failed after { max_retries } retries: { last_error }" )


async def get_json(
    url: str,
    timeout: Optional[float] = None,
    retries: int = MAX_RETRIES
) -> Any:
    """
    Perform GET request and return JSON response.
    Includes timeout and retry logic.
    """
    async def _fetch():
        timeout_config = _get_timeout( timeout )
        async with aiohttp.ClientSession( timeout=timeout_config ) as session:
            async with session.get( url ) as response:
                return await response.json()

    return await _retry_with_backoff( _fetch, max_retries=retries )


async def post_json(
    url: str,
    json: Dict[str, Any],
    timeout: Optional[float] = None,
    retries: int = MAX_RETRIES,
    headers: Optional[Dict[str, str]] = None
) -> Any:
    """
    Perform POST request with JSON body and return JSON response.
    Includes timeout and retry logic.
    """
    async def _fetch():
        timeout_config = _get_timeout( timeout )
        async with aiohttp.ClientSession( timeout=timeout_config ) as session:
            async with session.post( url, json=json, headers=headers ) as response:
                return await response.json()

    return await _retry_with_backoff( _fetch, max_retries=retries )


async def get_json_no_retry(
    url: str,
    timeout: Optional[float] = None
) -> Any:
    """
    Perform GET request without retries (for use in asyncio.gather where
    we want individual failures to return quickly).
    """
    try:
        timeout_config = _get_timeout( timeout )
        async with aiohttp.ClientSession( timeout=timeout_config ) as session:
            async with session.get( url ) as response:
                return await response.json()
    except ( aiohttp.ClientError, asyncio.TimeoutError, ValueError ) as e:
        # ValueError catches json.JSONDecodeError (its parent class)
        bt.logging.warning( f"HTTP GET failed: { url } - { e }" )
        return None
