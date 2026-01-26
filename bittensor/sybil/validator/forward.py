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

import time
import math
import bittensor as bt
import asyncio
import aiohttp
import numpy as np

from sybil.validator.utils import generate_challenges
from sybil.validator.reward import get_rewards
from sybil.base.consts import BURN_UID, BURN_WEIGHT

async def forward(self):
    """
    The forward function is called by the validator every time step.

    It is responsible for querying the network and scoring the responses.

    Args:
        self (:obj:`bittensor.neuron.Neuron`): The neuron object which contains all the necessary state for the validator.

    """
    
    # Post miner and validator info to the container    
    await broadcast_neurons(self.metagraph, self.validator_server_url)
    
    try:
        bt.logging.info(f"Getting mining pool scores from {self.validator_server_url}/validator/score/mining_pools")
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self.validator_server_url}/validator/score/mining_pools"
            ) as resp:
                result = await resp.json()
                # Extract all UIDs from the response
                # Assuming the response is a dict mapping mining_pool_uid to score info
                if not isinstance(result, dict):
                    bt.logging.error(f"Unexpected response format: {result}")
                    all_uids = []
                else:
                    all_uids = [int(x) for x in result.keys()]
                    bt.logging.info(f"Retrieved {len(all_uids)} UIDs from mining pool scores response")
                    all_scores = [float(x['score']) for x in result.values()]
                    # Update the scores in the metagraph
                    self.update_scores(all_scores, all_uids)
    except Exception as e:
        bt.logging.error(f"Failed to broadcast neurons info: {e}")

    time.sleep(10)


async def broadcast_neurons(metagraph, server_url):
    """
    Broadcast the neurons to the server.
    """
    bt.logging.info(f"Broadcasting neurons to {server_url}/protocol/broadcast/neurons")

    neurons_info = []
    block = int(metagraph.block)
    for neuron in metagraph.neurons:
        uid = neuron.uid
        neurons_info.append({
            'uid': uid,
            'ip': metagraph.axons[uid].ip,
            'validator_trust': neuron.validator_trust,
            "alpha_stake": float(metagraph.alpha_stake[uid].item()),
            'stake_weight': float(metagraph.S[uid].item()),
            'block': block,
            'hotkey': neuron.hotkey,
            'coldkey': neuron.coldkey,
            'excluded': uid == BURN_UID,
        })
    bt.logging.info(f"Submitting neurons info: {len(neurons_info)} neurons")
    try:     
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{server_url}/protocol/broadcast/neurons",
                json={"neurons": neurons_info}
            ) as resp:
                result = await resp.json()
                if result["success"]:
                    bt.logging.info(f"Broadcasted neurons info: {len(neurons_info)} neurons")
                else:
                    bt.logging.error(f"Failed to broadcast neurons info")
    except Exception as e:
        bt.logging.error(f"Failed to broadcast neurons info: {e}")