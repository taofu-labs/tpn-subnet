import asyncio
import aiohttp
from sybil.protocol import Challenge
from typing import List
import bittensor as bt


# Fetch a challenge from a given URL
async def fetch(url):
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            return await response.json()

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
async def generate_challenges(miner_uids: List[int], validator_server_url: str) -> List[Challenge]:
    try:
        tasks = []
        for uid in miner_uids:
            bt.logging.info(f"Generating challenge for miner uid: {uid}")
            url = f"{validator_server_url}/challenge/new?miner_uid={uid}"
            tasks.append(fetch(url))
        
        # Before fetching challenges, ensure the validator server is ready
        await wait_for_validator_container(validator_server_url)

        # Gather all the tasks to fetch challenges concurrently
        responses = await asyncio.gather(*tasks)
        
        challenges = [
            Challenge(
                challenge=response["challenge"],
                challenge_url=response["challenge_url"]
            ) for response in responses
        ]
        
        return challenges
    except Exception as e:
        print(f"Error generating challenges: {e}. Returning empty list.")
        return []

