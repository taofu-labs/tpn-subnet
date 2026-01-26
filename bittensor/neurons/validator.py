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


import os
import time
import datetime
import requests

# Bittensor
import bittensor as bt
try:
    import wandb
except ImportError:
    wandb = None

# import base validator class which takes care of most of the boilerplate
from sybil.base.validator import BaseValidatorNeuron

# Bittensor Validator Template:
from sybil.validator import forward


class Validator(BaseValidatorNeuron):
    """
    Your validator neuron class. You should use this class to define your validator's behavior. In particular, you should replace the forward function with your own logic.

    This class inherits from the BaseValidatorNeuron class, which in turn inherits from BaseNeuron. The BaseNeuron class takes care of routine tasks such as setting up wallet, subtensor, metagraph, logging directory, parsing config, etc. You can override any of the methods in BaseNeuron if you need to customize the behavior.

    This class provides reasonable default behavior for a validator such as keeping a moving average of the scores of the miners and using them to set weights at the end of each epoch. Additionally, the scores are reset for new hotkeys at the end of each epoch.
    """

    def __init__(self, config=None):
        super(Validator, self).__init__(config=config)
        
        bt.logging.info(f"===> Validator initialized: {self.step}, {len(self.scores)}, {len(self.hotkeys)}")

        self.wandb_run_start = None
        if not self.config.wandb.off and wandb is not None:
            if os.getenv("WANDB_API_KEY"):
                self.new_wandb_run()
            else:
                bt.logging.exception(
                    "WANDB_API_KEY not found. Set it with `export WANDB_API_KEY=<your API key>`. Alternatively, you can disable W&B with --wandb.off, but it is strongly recommended to run with W&B enabled."
                )
                self.config.wandb.off = True
        else:
            if wandb is None and not self.config.wandb.off:
                bt.logging.warning("WANDB library not installed. Disabling WANDB logging.")
                self.config.wandb.off = True
            else:
                bt.logging.warning(
                    "Running with --wandb.off. It is strongly recommended to run with W&B enabled."
                )

    def new_wandb_run(self):
        """Creates a new wandb run to save information to."""
        # Create a unique run id for this run.
        now = datetime.datetime.now()
        self.wandb_run_start = now
        run_id = now.strftime("%Y-%m-%d_%H-%M-%S")
        name = "validator-" + str(self.uid) + "-" + run_id
        self.wandb_run = wandb.init(
            name=name,
            project="tpn-validators",
            entity="tpn-subnet",
            config={
                "uid": self.uid,
                "hotkey": self.wallet.hotkey.ss58_address,
                "run_name": run_id,
                "type": "validator",
            },
            allow_val_change=True,
            anonymous="allow",
        )

        bt.logging.debug(f"Started a new wandb run: {name}")

    async def forward(self):
        """
        Validator forward pass. Consists of:
        - Generating the query
        - Querying the miners
        - Getting the responses
        - Rewarding the miners
        - Updating the scores
        """
        # TODO(developer): Rewrite this function based on your protocol definition.
        return await forward(self)

def check_validator_server(validator_server_url) -> bool:
    try:
        with requests.get(f"{validator_server_url}/") as resp:
            if resp.ok:
                bt.logging.info("Validator server is running")
            else:
                bt.logging.error(f"Validator server returned error: {resp.status_code}")
                return False
        return True
    except Exception as e:
        bt.logging.error(f"Failed to connect to validator server: {e}")
        return False
    
# The main function parses the configuration and runs the validator.
if __name__ == "__main__":
    validator = Validator()
    
    while not check_validator_server(validator.validator_server_url):
        bt.logging.info("Validator server is not running, waiting 10 seconds")
        time.sleep(10)
    
    with validator:
        while True:
            if not check_validator_server(validator.validator_server_url):
                bt.logging.error("Validator server is not running, exiting")
                exit(1)
                
            bt.logging.info(f"Validator running... {time.time()}")
            time.sleep(10)
