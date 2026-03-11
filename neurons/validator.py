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
import logging
import requests

# Bittensor
import bittensor as bt
import wandb

# import base validator class which takes care of most of the boilerplate
from sybil.base.validator import BaseValidatorNeuron

# Bittensor Validator Template:
from sybil.validator import forward


class UnknownSynapseFilter(logging.Filter):
    """Downgrades UnknownSynapseError logs from ERROR to WARNING."""

    def filter(self, record):
        msg = record.getMessage()
        if "UnknownSynapseError" not in msg:
            return True

        record.levelno = logging.WARNING
        record.levelname = "WARNING"

        try:
            synapse_name = msg.split("Synapse name '")[1].split("'")[0]
            record.msg = f"Ignored unsupported synapse request: '{synapse_name}'"
        except Exception:
            record.msg = "Ignored unsupported synapse request"

        record.args = None  # Prevent msg % args TypeError
        return True


class Validator(BaseValidatorNeuron):
    """
    Your validator neuron class. You should use this class to define your validator's behavior. In particular, you should replace the forward function with your own logic.

    This class inherits from the BaseValidatorNeuron class, which in turn inherits from BaseNeuron. The BaseNeuron class takes care of routine tasks such as setting up wallet, subtensor, metagraph, logging directory, parsing config, etc. You can override any of the methods in BaseNeuron if you need to customize the behavior.

    This class provides reasonable default behavior for a validator such as keeping a moving average of the scores of the miners and using them to set weights at the end of each epoch. Additionally, the scores are reset for new hotkeys at the end of each epoch.
    """

    def __init__(self, config=None):
        super(Validator, self).__init__(config=config)

        # Downgrade noisy UnknownSynapseError logs to WARNING
        try:
            bt.logging.logger.addFilter(UnknownSynapseFilter())
        except Exception as e:
            bt.logging.warning(f"Failed to install UnknownSynapseFilter: {e}")

        bt.logging.info(f"===> Validator initialized: {self.step}, {len(self.scores)}, {len(self.hotkeys)}")

        self.wandb_run_start = None
        if not self.config.wandb.off:
            if os.getenv("WANDB_API_KEY"):
                self.new_wandb_run()
            else:
                bt.logging.exception(
                    "WANDB_API_KEY not found. Set it with `export WANDB_API_KEY=<your API key>`. Alternatively, you can disable W&B with --wandb.off, but it is strongly recommended to run with W&B enabled."
                )
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

    def run(self):
        """Enhanced run() with transient network error recovery."""
        from traceback import format_exception

        self.sync()
        bt.logging.info(f"Validator starting at block: {self.block}")

        TRANSIENT_RETRY_DELAY = 30

        try:
            while True:
                try:
                    bt.logging.info(f"step({self.step}) block({self.block})")
                    self.loop.run_until_complete(self.concurrent_forward())

                    if self.should_exit:
                        break

                    self.sync()
                    self.step += 1

                except KeyboardInterrupt:
                    raise

                except Exception as err:
                    err_str = str(err)
                    is_transient = any(hint in err_str for hint in (
                        "gaierror", "TimeoutError", "SSLError",
                        "ConnectionError", "ConnectionRefused",
                        "ConnectionReset", "BrokenPipeError",
                    ))

                    if is_transient:
                        bt.logging.warning(
                            f"Transient network error: {err}. "
                            f"Retrying in {TRANSIENT_RETRY_DELAY}s..."
                        )
                    else:
                        bt.logging.error(f"Error during validation step: {err}")
                        bt.logging.debug("".join(format_exception(type(err), err, err.__traceback__)))

                    if self.should_exit:
                        break

                    # Poll should_exit each second so shutdown isn't blocked
                    # for the full TRANSIENT_RETRY_DELAY
                    for _ in range(TRANSIENT_RETRY_DELAY):
                        if self.should_exit:
                            break
                        time.sleep(1)

        except KeyboardInterrupt:
            self.axon.stop()
            bt.logging.success("Validator killed by keyboard interrupt.")
            exit()

        except Exception as err:
            bt.logging.error(f"Fatal error during validation: {str(err)}")
            bt.logging.debug("".join(format_exception(type(err), err, err.__traceback__)))

# Health check timeout in seconds
HEALTH_CHECK_TIMEOUT = 10

def check_validator_server( validator_server_url ) -> bool:
    try:
        with requests.get( f"{ validator_server_url }/", timeout=HEALTH_CHECK_TIMEOUT ) as resp:
            if resp.ok:
                bt.logging.info( "Validator server is running" )
            else:
                bt.logging.error( f"Validator server returned error: { resp.status_code }" )
                return False
        return True
    except requests.exceptions.Timeout:
        bt.logging.error( f"Health check timed out after { HEALTH_CHECK_TIMEOUT }s" )
        return False
    except Exception as e:
        bt.logging.error( f"Failed to connect to validator server: { e }" )
        return False
    
# Max consecutive health check failures before exiting (let PM2 restart)
MAX_CONSECUTIVE_FAILURES = 3

# The main function parses the configuration and runs the validator.
if __name__ == "__main__":
    # Retry initialization on transient network/subtensor failures
    validator = None
    while validator is None:
        try:
            validator = Validator()
        except Exception as e:
            bt.logging.error(f"Validator initialization failed: {e}. Retrying in 10s...")
            time.sleep(10)

    consecutive_failures = 0

    # Wait for validator server to be ready on startup
    while not check_validator_server( validator.validator_server_url ):
        bt.logging.info( "Validator server is not running, waiting 10 seconds" )
        time.sleep( 10 )

    with validator:
        while True:
            if not check_validator_server( validator.validator_server_url ):
                consecutive_failures += 1
                bt.logging.error(
                    f"Validator server health check failed "
                    f"({ consecutive_failures }/{ MAX_CONSECUTIVE_FAILURES })"
                )

                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    bt.logging.error(
                        f"Validator server unreachable after { MAX_CONSECUTIVE_FAILURES } "
                        f"consecutive failures, exiting for PM2 restart"
                    )
                    exit( 1 )
            else:
                # Reset counter on successful health check
                consecutive_failures = 0

            bt.logging.info( f"Validator running... { time.time() }" )
            time.sleep( 10 )
