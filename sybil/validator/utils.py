import asyncio
import aiohttp
from sybil.protocol import Challenge
from typing import List
import bittensor as bt

from sybil.utils.http import get_json_no_retry


# Fetch a challenge from a given URL (with timeout, no retry for use in asyncio.gather)
async def fetch( url ):
    return await get_json_no_retry( url )

# Wait until the / endpoint returns a 200 OK response
async def wait_for_validator_container(validator_server_url: str):
    max_retries = 10
    retries = 0
    while True:

        if retries >= max_retries:
            bt.logging.error("Validator server not ready after maximum retries. Allowing unhealthy continuation of neuron logic.")
            return

        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(validator_server_url) as response:
                    if response.status == 200:
                        bt.logging.info("Validator server is up and running.")
                        return
        except Exception as e:
            bt.logging.error(f"Validator server not ready yet: {e}")
        retries += 1
        await asyncio.sleep(10)  # Wait before retrying


# Generate one challenge per miner_uid, appending ?miner_uid=<uid> to each request
async def generate_challenges( miner_uids: List[int], validator_server_url: str ) -> List[Challenge]:
    try:
        # Ensure the validator server is ready before making requests
        await wait_for_validator_container( validator_server_url )

        # Create fetch tasks for each miner
        tasks = []
        for uid in miner_uids:
            bt.logging.info( f"Generating challenge for miner uid: { uid }" )
            url = f"{ validator_server_url }/challenge/new?miner_uid={ uid }"
            tasks.append( fetch( url ) )

        # Fetch all challenges concurrently
        responses = await asyncio.gather( *tasks )

        # Filter out None responses (from timeouts) and build challenges
        challenges = []
        for response in responses:
            if response is None:
                bt.logging.warning( "Skipping challenge due to failed fetch" )
                continue

            # Validate response has required fields
            if "challenge" not in response or "challenge_url" not in response:
                bt.logging.warning( f"Skipping malformed challenge response: { response }" )
                continue

            challenges.append( Challenge(
                challenge=response[ "challenge" ],
                challenge_url=response[ "challenge_url" ]
            ) )

        return challenges
    except Exception as e:
        bt.logging.error( f"Error generating challenges: { e }. Returning empty list." )
        return []

