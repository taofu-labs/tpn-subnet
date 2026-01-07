import random
import bittensor as bt
import numpy as np
from typing import List


def check_uid_availability(
    metagraph: "bt.Metagraph.Metagraph", uid: int, vpermit_tao_limit: int
) -> bool:
    """Check if uid is available. The UID should be available if it is serving and has less than vpermit_tao_limit stake
    Args:
        metagraph (:obj: bt.Metagraph.Metagraph): Metagraph object
        uid (int): uid to be checked
        vpermit_tao_limit (int): Validator permit tao limit
    Returns:
        bool: True if uid is available, False otherwise
    """
    # # Filter non serving axons.
    if not metagraph.axons[uid].is_serving:
        return False
    # # Filter validator permit > 1024 stake.
    # if metagraph.validator_permit[uid]:
    #     if metagraph.S[uid] > vpermit_tao_limit:
    #         return False
    # # Available otherwise.
    # return True
    return True
