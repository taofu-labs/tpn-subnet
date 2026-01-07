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
import typing
import asyncio
import aiohttp
import bittensor as bt

import sybil

# import base miner class which takes care of most of the boilerplate
from sybil.base.miner import BaseMinerNeuron
from sybil.base.consts import BURN_UID, BURN_WEIGHT


class Miner(BaseMinerNeuron):
    """
    Your miner neuron class. You should use this class to define your miner's behavior. In particular, you should replace the forward function with your own logic. You may also want to override the blacklist and priority functions according to your needs.

    This class inherits from the BaseMinerNeuron class, which in turn inherits from BaseNeuron. The BaseNeuron class takes care of routine tasks such as setting up wallet, subtensor, metagraph, logging directory, parsing config, etc. You can override any of the methods in BaseNeuron if you need to customize the behavior.

    This class provides reasonable default behavior for a miner such as blacklisting unrecognized hotkeys, prioritizing requests based on stake, and forwarding requests to the forward function. If you need to define custom
    """

    def __init__(self, config=None):
        super(Miner, self).__init__(config=config)

        # TODO(developer): Anything specific to your use case you can do here

    async def forward(
        self, synapse: sybil.protocol.Challenge
    ) -> sybil.protocol.Challenge:
        """
        Processes the incoming 'Challenge' synapse by performing a predefined operation on the input data.
        This method should be replaced with actual logic relevant to the miner's purpose.

        Args:
            synapse (sybil.protocol.Challenge): The synapse object containing the 'challenge_url' data.
        """
        
        bt.logging.info(f"Received challenge: {synapse.challenge_url}")
        
        challenge_url = synapse.challenge_url

        try:
            async with aiohttp.ClientSession() as session:
                bt.logging.info(f"Sending challenge to {self.miner_server}/challenge")
                async with session.post(
                    f"{self.miner_server}/challenge",
                    json={"url": challenge_url},
                    headers={"Content-Type": "application/json"},
                ) as response:
                    response = (await response.json())["response"]
                    synapse.challenge_response = response
                    bt.logging.info(f"Solved challenge: {synapse.challenge_response}")
                    return synapse
        except Exception as e:
            bt.logging.error(f"Error solving challenge: {e}")
            return synapse

    async def blacklist(
        self, synapse: sybil.protocol.Challenge
    ) -> typing.Tuple[bool, str]:
        """
        Determines whether an incoming request should be blacklisted and thus ignored. Your implementation should
        define the logic for blacklisting requests based on your needs and desired security parameters.

        Blacklist runs before the synapse data has been deserialized (i.e. before synapse.data is available).
        The synapse is instead contracted via the headers of the request. It is important to blacklist
        requests before they are deserialized to avoid wasting resources on requests that will be ignored.

        Args:
            synapse (sybil.protocol.Dummy): A synapse object constructed from the headers of the incoming request.

        Returns:
            Tuple[bool, str]: A tuple containing a boolean indicating whether the synapse's hotkey is blacklisted,
                            and a string providing the reason for the decision.

        This function is a security measure to prevent resource wastage on undesired requests. It should be enhanced
        to include checks against the metagraph for entity registration, validator status, and sufficient stake
        before deserialization of synapse data to minimize processing overhead.

        Example blacklist logic:
        - Reject if the hotkey is not a registered entity within the metagraph.
        - Consider blacklisting entities that are not validators or have insufficient stake.

        In practice it would be wise to blacklist requests from entities that are not validators, or do not have
        enough stake. This can be checked via metagraph.S and metagraph.validator_permit. You can always attain
        the uid of the sender via a metagraph.hotkeys.index( synapse.dendrite.hotkey ) call.

        Otherwise, allow the request to be processed further.
        """

        if synapse.dendrite is None or synapse.dendrite.hotkey is None:
            bt.logging.warning(
                "Received a request without a dendrite or hotkey."
            )
            return True, "Missing dendrite or hotkey"

        # TODO(developer): Define how miners should blacklist requests.
        uid = self.metagraph.hotkeys.index(synapse.dendrite.hotkey)
        if (
            not self.config.blacklist.allow_non_registered
            and synapse.dendrite.hotkey not in self.metagraph.hotkeys
        ):
            # Ignore requests from un-registered entities.
            bt.logging.trace(
                f"Blacklisting un-registered hotkey {synapse.dendrite.hotkey}"
            )
            return True, "Unrecognized hotkey"

        if self.config.blacklist.force_validator_permit:
            # If the config is set to force validator permit, then we should only allow requests from validators.
            if not self.metagraph.validator_permit[uid]:
                bt.logging.warning(
                    f"Blacklisting a request from non-validator hotkey {synapse.dendrite.hotkey}"
                )
                return True, "Non-validator hotkey"

        bt.logging.trace(
            f"Not Blacklisting recognized hotkey {synapse.dendrite.hotkey}"
        )
        return False, "Hotkey recognized!"

    async def priority(self, synapse: sybil.protocol.Challenge) -> float:
        """
        The priority function determines the order in which requests are handled. More valuable or higher-priority
        requests are processed before others. You should design your own priority mechanism with care.

        This implementation assigns priority to incoming requests based on the calling entity's stake in the metagraph.

        Args:
            synapse (sybil.protocol.Dummy): The synapse object that contains metadata about the incoming request.

        Returns:
            float: A priority score derived from the stake of the calling entity.

        Miners may receive messages from multiple entities at once. This function determines which request should be
        processed first. Higher values indicate that the request should be processed first. Lower values indicate
        that the request should be processed later.

        Example priority logic:
        - A higher stake results in a higher priority value.
        """
        if synapse.dendrite is None or synapse.dendrite.hotkey is None:
            bt.logging.warning(
                "Received a request without a dendrite or hotkey."
            )
            return 0.0

        # TODO(developer): Define how miners should prioritize requests.
        caller_uid = self.metagraph.hotkeys.index(
            synapse.dendrite.hotkey
        )  # Get the caller index.
        priority = float(
            self.metagraph.S[caller_uid]
        )  # Return the stake as the priority.
        bt.logging.trace(
            f"Prioritizing {synapse.dendrite.hotkey} with value: {priority}"
        )
        return priority
    
    async def broadcast_neurons(self):
        """
        Broadcast the neurons to the miner server.
        """
        bt.logging.info(f"Broadcasting neurons to {self.miner_server}/protocol/broadcast/neurons")

        neurons_info = []
        block = int(self.metagraph.block)
        for neuron in self.metagraph.neurons:
            uid = neuron.uid
            neurons_info.append({
                'uid': uid,
                'ip': self.metagraph.axons[uid].ip,
                'validator_trust': neuron.validator_trust,
                'trust': neuron.trust,
                "alpha_stake": float(self.metagraph.alpha_stake[uid].item()),
                'stake_weight': float(self.metagraph.S[uid].item()),
                'block': block,
                'hotkey': neuron.hotkey,
                'coldkey': neuron.coldkey,
                'excluded': uid == BURN_UID,
            })
        bt.logging.info(f"Submitting neurons info: {len(neurons_info)} neurons")
        try:     
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.miner_server}/protocol/broadcast/neurons",
                    json={"neurons": neurons_info}
                ) as resp:
                    result = await resp.json()
                    if result["success"]:
                        bt.logging.info(f"Broadcasted neurons info: {len(neurons_info)} neurons")
                    else:
                        bt.logging.error(f"Failed to broadcast neurons info")
        except Exception as e:
            bt.logging.error(f"Failed to broadcast neurons info: {e}")


def check_if_miner_registered(neuron):
    """
    Check if the miner is registered in the metagraph.
    """
    
    subtensor = bt.Subtensor(config=neuron.config)
    metagraph = subtensor.metagraph(neuron.config.netuid)

    is_registered = neuron.wallet.hotkey.ss58_address in metagraph.hotkeys
    if not is_registered:
        bt.logging.error(f"Miner {neuron.wallet.hotkey.ss58_address} is not registered in the metagraph")
        exit()
    else:
        bt.logging.info(f"Neuron registration check passed")

# This is the main function, which runs the miner.
if __name__ == "__main__":
    with Miner() as miner:
        # Create event loop if not already running
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        async def periodic_broadcast():
            last_broadcast = None
            broadcast_interval_minutes = 1
            while True: 
                check_if_miner_registered(miner)
                if last_broadcast is None or time.time() - last_broadcast > broadcast_interval_minutes * 60:
                    await miner.broadcast_neurons()
                    last_broadcast = time.time()
                await asyncio.sleep(60)  # 60 seconds between broadcasts

        # Run the periodic broadcast in the background
        loop.run_until_complete(periodic_broadcast())
        
        while True:
            bt.logging.info(f"Miner running... {time.time()}")
            time.sleep(20)
