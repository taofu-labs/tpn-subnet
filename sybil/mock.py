import time

import asyncio
import random
import bittensor as bt
from bittensor.utils.mock import MockSubtensor as BtMockSubtensor
from bittensor.core.chain_data import NeuronInfoLite

from typing import List, Optional


class MockSubtensor(BtMockSubtensor):
    def __init__(self, netuid, n=16, wallet=None, network="mock"):
        super().__init__(network=network)

        # subnet_exists() is not mocked in bittensor 10.x — call create_subnet directly
        self.create_subnet(netuid)
        # create_subnet initializes state but doesn't mark NetworksAdded — do it explicitly
        self.chain_state["SubtensorModule"]["NetworksAdded"][netuid] = True

        # Register ourself (the validator) as a neuron at uid=0
        if wallet is not None:
            self.force_register_neuron(
                netuid=netuid,
                hotkey_ss58=wallet.hotkey.ss58_address,
                coldkey_ss58=wallet.coldkey.ss58_address,
                stake=100000,
                balance=100000,
            )

        # Register n mock neurons who will be miners
        for i in range(1, n + 1):
            self.force_register_neuron(
                netuid=netuid,
                hotkey_ss58=f"miner-hotkey-{i}",
                coldkey_ss58="mock-coldkey",
                stake=100000,
                balance=100000,
            )

    def neuron_for_uid_lite(self, uid: int, netuid: int, block: Optional[int] = None) -> Optional[NeuronInfoLite]:
        # bittensor 10.x removed rank/trust/pruning_score from NeuronInfoLite but the
        # parent mock still references them — override to build with correct fields only
        neuron_info = self._neuron_subnet_exists(uid, netuid, block)
        if neuron_info is None:
            return None
        return NeuronInfoLite(
            hotkey=neuron_info.hotkey,
            coldkey=neuron_info.coldkey,
            uid=neuron_info.uid,
            netuid=neuron_info.netuid,
            active=neuron_info.active,
            stake=neuron_info.stake,
            stake_dict=neuron_info.stake_dict,
            total_stake=neuron_info.total_stake,
            emission=neuron_info.emission,
            incentive=neuron_info.incentive,
            consensus=neuron_info.consensus,
            validator_trust=neuron_info.validator_trust,
            dividends=neuron_info.dividends,
            last_update=neuron_info.last_update,
            validator_permit=neuron_info.validator_permit,
            prometheus_info=neuron_info.prometheus_info,
            axon_info=neuron_info.axon_info,
            is_null=neuron_info.is_null,
        )


class MockMetagraph(bt.Metagraph):
    def __init__(self, netuid=1, network="mock", subtensor=None):
        super().__init__(netuid=netuid, network=network, sync=False)

        if subtensor is not None:
            self.subtensor = subtensor
        self.sync(subtensor=subtensor)

        for axon in self.axons:
            axon.ip = "127.0.0.0"
            axon.port = 8091

        bt.logging.info(f"Metagraph: {self}")
        bt.logging.info(f"Axons: {self.axons}")

    def _apply_extra_info(self, block: Optional[int] = None):
        # bittensor 10.x added this to fetch MetagraphInfo from chain, which MagicMock
        # can't satisfy — skip it, we don't need the extra metadata for mock testing
        pass


class MockDendrite(bt.Dendrite):
    """
    Replaces a real bittensor network request with a mock request that just returns some static response for all axons that are passed and adds some random delay.
    """

    def __init__(self, wallet):
        super().__init__(wallet)

    async def forward(
        self,
        axons: List[bt.Axon],
        synapse: bt.Synapse = bt.Synapse(),
        timeout: float = 12,
        deserialize: bool = True,
        run_async: bool = True,
        streaming: bool = False,
    ):
        if streaming:
            raise NotImplementedError("Streaming not implemented yet.")

        async def query_all_axons(streaming: bool):
            """Queries all axons for responses."""

            async def single_axon_response(i, axon):
                """Queries a single axon for a response."""

                start_time = time.time()
                s = synapse.copy()
                # Attach some more required data so it looks real
                s = self.preprocess_synapse_for_request(axon, s, timeout)
                # We just want to mock the response, so we'll just fill in some data
                process_time = random.random()
                if process_time < timeout:
                    s.dendrite.process_time = str(time.time() - start_time)
                    # Update the status code and status message of the dendrite to match the axon
                    # TODO (developer): replace with your own expected synapse data
                    s.dummy_output = s.dummy_input * 2
                    s.dendrite.status_code = 200
                    s.dendrite.status_message = "OK"
                    synapse.dendrite.process_time = str(process_time)
                else:
                    s.dummy_output = 0
                    s.dendrite.status_code = 408
                    s.dendrite.status_message = "Timeout"
                    synapse.dendrite.process_time = str(timeout)

                # Return the updated synapse object after deserializing if requested
                if deserialize:
                    return s.deserialize()
                else:
                    return s

            return await asyncio.gather(
                *(
                    single_axon_response(i, target_axon)
                    for i, target_axon in enumerate(axons)
                )
            )

        return await query_all_axons(streaming)

    def __str__(self) -> str:
        """
        Returns a string representation of the Dendrite object.

        Returns:
            str: The string representation of the Dendrite object in the format "dendrite(<user_wallet_address>)".
        """
        return "MockDendrite({})".format(self.keypair.ss58_address)
