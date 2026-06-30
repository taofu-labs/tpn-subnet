# The MIT License (MIT)
# Copyright © 2023 Yuma Rao
# TODO(developer): Set your name
# Copyright © 2023 <your name>

# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
# and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all copies or substantial portions of
# the Software.

# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
# THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
# DEALINGS IN THE SOFTWARE.

import time
import bittensor as bt


async def forward(self):
    """
    Deprecated: sets 100% weight to UID 0.
    Federated container is no longer required or started.
    """
    bt.logging.info("Deprecation mode: setting 100% weight to UID 0")
    self.update_scores([1.0], [0])
    time.sleep(10)


# Deprecated — federated container not running in validator deprecation mode
# async def broadcast_neurons(metagraph, server_url):
#     """
#     Broadcast the neurons to the server.
#     """
#     bt.logging.info( f"Broadcasting neurons to { server_url }/protocol/broadcast/neurons" )
#
#     neurons_info = []
#     block = int(metagraph.block)
#     for neuron in metagraph.neurons:
#         uid = neuron.uid
#         neurons_info.append({
#             'uid': uid,
#             'ip': metagraph.axons[uid].ip,
#             'validator_trust': neuron.validator_trust,
#             "alpha_stake": float(metagraph.alpha_stake[uid].item()),
#             'stake_weight': float(metagraph.S[uid].item()),
#             'block': block,
#             'hotkey': neuron.hotkey,
#             'coldkey': neuron.coldkey,
#             'excluded': uid == BURN_UID,
#         })
#     bt.logging.info( f"Submitting neurons info: { len( neurons_info ) } neurons" )
#     try:
#         result = await post_json(
#             f"{ server_url }/protocol/broadcast/neurons",
#             json={ "neurons": neurons_info }
#         )
#         if result.get( "success" ):
#             bt.logging.info( f"Broadcasted neurons info: { len( neurons_info ) } neurons" )
#         else:
#             bt.logging.error( f"Failed to broadcast neurons info: { result }" )
#     except HTTPClientError as e:
#         bt.logging.error( f"Failed to broadcast neurons info after retries: { e }" )
#     except Exception as e:
#         bt.logging.error( f"Failed to broadcast neurons info: { e }" )
