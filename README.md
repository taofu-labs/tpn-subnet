# TPN - Tao Private Network

The TPN subnet coordinates miners that offer VPN connections in a wide variety of geographic locations.

In the TPN subnet, there are three kinds of nodes:

- **Workers**: These are easy to run nodes that provide VPN connections and get rewarded by mining pools. They are simple to set up machines with no Bittensor neuron at all.
- **Miners**: These nodes offer the VPN connections that workers provide and are given subnet emissions, they are responsible for distributing those rewards to workers however they see fit. Profitability depends on how you decide to pay the workers that sign up to your pool
- **Validators**: These nodes validate the work of miners and act as an interface to end users

Want to know more? Please read the [FAQ](#faq).

## Quickstart

Getting started checklist:

- [ ] Decide if you want to run a worker, mining pool, or validator. 99% chance you should run a worker.
- [ ] Have a Debian/Ubuntu machine with 2 cores and 2GiB+ RAM ready
- [ ] Run the steps in the `Preparing your machine` section
- [ ] Run the steps in the `Running a worker/mining pool/validator` section
- [ ] If you will run a worker, you decided on a mining pool. You can find mining pools either on Taostats or if you want details on then, enter the TPN Discord channel in the [Bittensor Discord](https://discord.com/invite/bittensor)

> [!TIP] 
> Are you a technically savvy person who wants to run a **worker** and already understands how the subnet works? You can simply run the script below. When you run it it will ask for the input needed to set up a worker.

```bash
curl -s https://raw.githubusercontent.com/taofu-labs/tpn-subnet/refs/heads/main/scripts/install_worker.sh | bash
```

## Note on rewards algorithm

Emissions for miners on this subnet are based linearly on your worker pool size and geographic uniqueness. In principle: ` amount of workers * geographic diversity * slowness penalty`.

This means that counter to the old version of this subnet:

1. There is NO BENEFIT to running multiple miners, you should focus on workers. If you run many workers, running your own pool can be a good strategy. Operating multiple mining pools has no benefit unless you are distributing rewards to third party workers in some novel way
2. Geographic uniqueness and pool size are both very important, you can find the code that scores mining pools [in this file](https://github.com/taofu-labs/tpn-subnet/blob/main/federated-container/modules/scoring/score_mining_pools.js#L162)
3. While speed and bandwidth size will matter soon, at this stage what matters most is that your workers and mining pool respond with reasonable speed. What matters most there is having a decent CPU and not being stingy on RAM

## Preparing your machine

Before starting your server, please prepare your machine by setting up the required enrivonment.

### 1: Installing dependencies

Requirements:

- Linux OS (Ubuntu LTS recommended)
- 2 CPU cores
- 1-2GB RAM for a worker, 4-8GB RAM for a mining pool, 8-16GB RAM for a validator
- 10-20 GB disk space for a worker, 50GB disk space for a mining pool or validator
- Publically accessible IP address

All servers share some of the same dependencies. No matter which you choose to run, please install the dependencies by executing the following commands:

```bash
# Install the required system dependencies
sudo apt update
sudo apt install -y git jq netcat-openbsd
sudo apt upgrade -y # OPTIONAL, this updated system packages

# Install docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install wireguard and wireguard-tools, these are commonly preinstalled on Ubuntu
sudo apt install -y wireguard wireguard-tools
sudo modprobe wireguard

# Clone the TPN repository, it contains all the required code
cd ~
git clone https://github.com/taofu-labs/tpn-subnet.git
# Add the current user to docker for rootless docker running
if [ -z "$USER" ]; then
    USER=$(whoami)
fi
sudo groupadd docker &> /dev/null
sudo usermod -aG docker $USER
newgrp docker << EOF
    sudo service docker start
EOF
```

For miners and validators, you also need to install python and Bittensor components:

> [!CAUTION]
> Workers: ignore the setup steps below, you do NOT need them.

```bash
# Install python, node and pm2
sudo apt install -y nodejs npm python3 python3-venv python3-pip
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
RC_PATH="$HOME/.${SHELL##*/}rc"
echo "Using rc path $RC_PATH"
echo 'export PATH=~/.npm-global/bin:$PATH' >> "$RC_PATH"
source "$RC_PATH"
npm install -g pm2

# Install the required python dependencies
cd ~/tpn-subnet
python3 -m venv venv
source venv/bin/activate
TPN_CACHE="$HOME/.tpn_cache"
mkdir -p $TPN_CACHE
export TMPDIR=$TPN_CACHE
export WANDB_CACHE_DIR=$TPN_CACHE
pip3 install -r requirements.txt
export PYTHONPATH=.
```

### 2: Configure your environment

You need so set some settings so make sure your server operates how you want. This influences things like on what address you get paid and so forth.

```bash
cd tpn-subnet/federated-container
# Select the appropriate template
cp .env.{worker,miner,validator}.example .env
# Edit .env with your specific configuration
nano .env
```

Take note of the mandatory and optional sections. For miners and validators, you need to get these two external API keys:

- Make an account at https://lite.ip2location.com/. Set it as the `IP2LOCATION_DOWNLOAD_TOKEN` environment variable in the docker compose file. Add this in the specified location in the `.env` file you copied above.
- Make an account at https://www.maxmind.com and generate a license key in account settings. Add this in the specified location in the `.env` file you copied above.

### 3: Configure keys (mining pool/validator only)

> [!CAUTION]
> Workers: ignore this section

The next step is to configure the Bittensor keys for your miner and/or validator. Note that these keys are stored in the `~/.bittensor` directory. You have 2 options:

1. Copy existing cold and hotkeys to `~/.bittensor`
2. Generate a new coldkey and hotkey

If you have existing keys that you are deploying, copy them in the following structure:

```bash
~/.bittensor/
├── tpn_coldkey # This directory name is how btcli knows the name of your coldkey
│   ├── coldkeypub.txt # This file contains your public coldkey, NOT THE PRIVATE KEY, the miner machine does not need the private key
|   └── hotkeys # This directory contains the private keys of your hotkeys
|       ├── tpn_hotkey # This file contains the private key of your hotkey in json format
```

If you want to generate new keys, execute the following commands:

```bash
btcli w new_coldkey --wallet.name tpn_coldkey
btcli w new_hotkey --wallet.name tpn_coldkey --wallet.hotkey tpn_hotkey
``` 

Note that the above will generate a private key for your coldkey as well. This is a key with security implications and should be stored securely. Ideally you delete it from your miner server after backing it up safely. This can be done by running `rm ~/.bittensor/wallets/tpn_coldkey/coldkey`, only do this AFTER YOU SECURELY BACKED UP YOUR KEY AND SEED PHRASE.

You will now need to register your key with Bittensor. The registration costs for this can be found on our [Taostats subnet page](https://taostats.io/subnets/65/registration), as well as the amount of available registration slots. The slots become available every 72 minutes, so if there are none available you should wait.

To register:

1. Get your cold key public key by runing: `cat ~/.bittensor/wallets/tpn_coldkey/coldkeypub.txt | jq -r '.ss58Address'`
2. Send TAO to your public key, we recommend sending the registration cost and some extra for gas fees
3. Verify that you have a balance on your wallet using `btcli wallet balance --ss58 YOUR_ss58_ADDRESS`
4. Register by running `btcli s register --wallet.name tpn_coldkey --hotkey tpn_hotkey --netuid 65`, this commamnd will ask for the colekey password you created previously

You may now continue with the rest of the setup. Your registration is immune to being deregistered for 5000 blocks which is about 16 hours. Make sure you finish your setup within this window.

## Running a worker

A worker is just a docker image with some settings.

> [!NOTE]
> Before doing this, set up your .env file correctly. See the section "3: Configure your environment"

To start the worker run:

```bash
bash ~/tpn-subnet/scripts/update_node.sh
```

To update your worker at any time, run that same command again.

> [!NOTE]
> The update script can be customised, for details run `bash ~/tpn-subnet/scripts/update_node.sh --help`

## Running a mining pool

The miner consists out of two components:

1. A miner docker container that is managed through `docker`
2. A miner neuron that is managed through `pm2`

To start the miner docker container, three things must be done: setting up an env and starting docker. Docker will know to run as a mining pool due to your `.env` settings. 


> [!NOTE]
> Before doing this, set up your .env file correctly. See the section "3: Configure your environment"

To start the miner neuron:

```bash
# NOTE: this assumes you are in the tpn-subnet directory
# Use netuid 65 for mainnet, 279 for testnet
cd ~/tpn-subnet
export PYTHONPATH=. && \
source venv/bin/activate && \
pm2 start "python3 ~/tpn-subnet/neurons/miner.py \
    --netuid 65 \
    --subtensor.network finney \
    --wallet.name tpn_coldkey \
    --wallet.hotkey tpn_hotkey \
    --logging.info \
    --axon.port 8091 \
    --blacklist.force_validator_permit" --name tpn_miner
```

Then start docker compose like so:

```bash
bash ~/tpn-subnet/scripts/update_node.sh
```

### Updating your miner

The miner automatically updates some components periodically, but not all. You should regularly run the following commands to keep your miner up to date:

```bash
# Run the update script, this assumes the tpn repository is located at ~/tpn-subnet
bash ~/tpn-subnet/scripts/update_node.sh
```

> [!NOTE]
> The update script can be customised, for details run `bash ~/tpn-subnet/scripts/update_node.sh --help`

### Paying your workers

How mining pools pay workers is up to them. We encourage innovation and experimentation. All workers have a configured EVM wallet address and/or Bittensor address on which they request payment. As a mining pool you can periodically call the worker performance endpoint on your machine to do the payments according to your protocols.

To get the worker performance and payment addresses:

- Set a `ADMIN_API_KEY` in your `.env`
- Call your pool machine with that API key and requested format like so:

```bash
ADMIN_API_KEY=
SERVER_PUBLIC_PROTOCOL=http
SERVER_PUBLIC_HOST=your_public_ip_here
SERVER_PUBLIC_PORT=3000
FORMAT='json'
GROUP_BY='ip'
# Change the parameters history_days, from, to, and format to your desired values
# Note that you can set wither history_days, or to/from, but not both at the same time
# Format may be set to json or csv
# group_by may be set to ip, payment_address_bittensor, payment_address_evm
curl "$SERVER_PUBLIC_PROTOCOL://$SERVER_PUBLIC_HOST:$SERVER_PUBLIC_PORT/api/worker_performance?api_key=$ADMIN_API_KEY&from=yyyy-mm-dd&to=yyyy-mm-dd&format=$FORMAT&group_by=$GROUP_BY"
```

As a mining pool you communicate how you pay workers by setting these variables in your `.env`:

- `MINING_POOL_REWARDS`: a string with a description. For example "I will split rewards monthly and manually transfer the amount of subnet alpha to workers in this pool"
- `MINING_POOL_WEBSITE_URL`: a url where you can have detailed documentation about how you run your pool and reward your workers

Here are some examples of how a minint pool could operate:

- You do not pay workers, meaning you will probably run all your workers yourself since nobody has an incentive to join your pool
- You pay workers in subnet alpha on a periodic basis. If you are very sophisticated you could write a script that does so daily or even hourly.
- You pay workers in stablecoins on their EVM address and you keep the subnet alpha

## Running a validator

Validators are the interface between end users and miners. They send work requests to miners, which the miners complete and submit to the validator. Running a validator is more complicated than a miner and requires more setup than a miner.

### Step 1: Configure the validator settings

The validator neuron needs you to supply a WanDB API key. You can get one by signing up at [WanDB](https://wandb.ai/site). Once you have the key, add it to your environment by running the code below:

```bash
# 🚨 Change the below to your API key
WANDB_API_KEY=xxxx

# Determine the default login shell using the SHELL env variable
shell=$(basename "$SHELL")
export_line="export WANDB_API_KEY=$WANDB_API_KEY"

# For bash: if the default shell is bash, add the export_line to ~/.bashrc if not present
if [[ "$shell" == "bash" ]]; then
  # Check if the exact export_line exists in ~/.bashrc
  if ! grep -Fxq "$export_line" ~/.bashrc; then
    echo "$export_line" >> ~/.bashrc  # Append if not found
    echo "Added '$export_line' to ~/.bashrc"
  else
    echo "'$export_line' already exists in ~/.bashrc"
  fi
fi

# For zsh: if the default shell is zsh, add the export_line to ~/.zshrc if not present
if [[ "$shell" == "zsh" ]]; then
  # Check if the exact export_line exists in ~/.zshrc
  if ! grep -Fxq "$export_line" ~/.zshrc; then
    echo "$export_line" >> ~/.zshrc  # Append if not found
    echo "Added '$export_line' to ~/.zshrc"
  else
    echo "'$export_line' already exists in ~/.zshrc"
  fi
fi

# Run the export line in the current shell
eval $export_line
```

### Step 2: Start the validator

The validator also consists out of two components:

1. A validator neuron that is managed through `pm2`
1. A validator docker container that is managed through `docker`

To start the validator neuron:

```bash
# NOTE: this assumes you are in the tpn-subnet director
# Use netuid 65 for mainnet, 279 for testnet
export PYTHONPATH=. && pm2 start "python3 ~/tpn-subnet/neurons/validator.py \
    --netuid 65 \
    --subtensor.network finney \ # Finney means mainnet, test means testnet
    --wallet.name tpn_coldkey \
    --wallet.hotkey tpn_hotkey \
    --logging.info \
    --axon.port 9000 \
    --neuron.vpermit 10000 \
    --force_validator_permit" --name tpn_validator
```


To start the docker container run the command below. Docker will know to run as a validator due to your `.env` settings.

> [!NOTE]
> Before doing this, set up your .env file correctly. See the section "3: Configure your environment"

```bash
bash ~/tpn-subnet/scripts/update_node.sh
```


### Updating your validator

The validator automatically updates some components periodically, but not all. You should regularly run the following commands to keep your validator up to date:

```bash
# Run the update script, this assumes the tpn repository is located at ~/tpn-subnet
bash ~/tpn-subnet/scripts/update_node.sh
```

> [!NOTE]
> The update script can be customised, for details run `bash ~/tpn-subnet/scripts/update_node.sh --help`

## Configuring TLS

To enable TLS connections for your node, take the following steps:

- [ ] Register a domain name, for example `example.com`
- [ ] Create a subdomain that points to the ip address of your node, for example `validator.example.com` to `1.2.3.4`
- [ ] In your `.env` file set the relevant variables: `SWAG_DOMAIN_NAME`, `SWAG_SUBDOMAINS`, `SWAG_EMAIL`
- [ ] Run the update script, then test your domain name at `https://validator.example.com`, it should show your validator information

## FAQ

### How will workers get paid?

A worker specifies a mining pool when it gets set up. The mining pools get to decide how they pay their workers. If all mining pools used the same payment structures, there would be no need to have multiple mining pools after all.

We encourage mining pools to offer innovative ways of paying workers. For example by streaming subnet alpha token emissions, or even sending stable coins on non-Bittensor networks.

### How do I know what mining pools exist?

There are two ways to find out what mining pools exist: either look at the miners on Taostats, or go into the TPN subnet channel in the Bittensor Discord.

### How do mining pools make money?

The mining pools receive TPN subnet emissions based on the workers they manage. How much money a mining pool makes depends on how much of those rewards they pass on to workers.

### Does it make sense to run multiple mining pools?

Only if you intend to attract workers with different offerings (like payment methods). There is no subnet-level advantage to running multiple mining pools.
