# The MIT License (MIT)
# Copyright © 2023 Yuma Rao
# TODO(developer): Set your name
# Copyright © 2023 <your name>

# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the “Software”), to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
# and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all copies or substantial portions of
# the Software.

# THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
# THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
# DEALINGS IN THE SOFTWARE.
import numpy as np
from typing import List
import bittensor as bt
import aiohttp
import asyncio

def reward(query: int, response: int) -> float:
    """
    Reward the miner response to the dummy request. This method returns a reward
    value for the miner, which is used to update the miner's score.

    Returns:
    - float: The reward value for the miner.
    """
    bt.logging.info(
        f"In rewards, query val: {query}, response val: {response}, rewards val: {1.0 if response == query * 2 else 0}"
    )
    return 1.0 if response == query * 2 else 0


async def get_rewards(challenges: List[str], responses: List[str], validator_server_url: str) -> List[float]:
    try:
        """
        Get the scores for the responses.
        """
        async def fetch_score(challenge, response) -> float:
            bt.logging.info(f"Getting score at: {validator_server_url}/challenge/{challenge}/{response}")
            if response is None:
                return 0
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{validator_server_url}/challenge/{challenge}/{response}"
                ) as resp:
                    result = await resp.json()
                    if result["score"]:
                        bt.logging.info(f"Score: {result['score']}")
                    else:
                        bt.logging.info(f"No score found in response: {result}")
                    return result["score"] if "score" in result else 0
                
        # Concurrently fetch all scores
        scores = await asyncio.gather(
            *[fetch_score(challenge, response) for challenge, response in zip(challenges, responses)]
        )
        
        # Convert None to 0
        scores = [0 if score is None else score for score in scores]
        
        return scores
    except Exception as e:
        print(f"Error getting rewards: {e}")
        return None
