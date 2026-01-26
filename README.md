# TPN - Tao Private Network

The TPN subnet coordinates miners that offer VPN connections in a wide variety of geographic locations.

In the TPN subnet, there are three kinds of nodes:

- **Workers**: These are easy to run nodes that provide VPN connections and get rewarded by mining pools. They are simple to set up machines with no Bittensor neuron at all.
- **Miners**: These nodes offer the VPN connections that workers provide and are given subnet emissions, they are responsible for distributing those rewards to workers however they see fit. Profitability depends on how you decide to pay the workers that sign up to your pool
- **Validators**: These nodes validate the work of miners and act as an interface to end users

Want to know more? Please read the [FAQ](#faq).

## Quickstart

Getting started checklist:

- [ ] Decide if you want to run a worker, miner, or validator. 99% chance you should run a worker.
- [ ] Have a Debian/Ubuntu machine with 2 cores and 2GiB+ RAM ready
- [ ] Run the steps in the `Preparing your machine` section
- [ ] Prepare your Hotkey and registration in the `Keys & Registration` section (Miners/Validators only)
- [ ] Configure your `.env` and launch in the `Running your Node` section

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
pip3 install -r requirements.txt
export PYTHONPATH=.
```

## Keys & Registration (Miner/Validator Only)

Before launching your node, you must set up your Bittensor keys and register them. Note that these keys are stored in the `~/.bittensor` directory.

### 1: Configure Keys
You have 2 options:
1. **Copy existing keys** to `~/.bittensor/wallets/`
2. **Generate new keys**:
   ```bash
   btcli w new_coldkey --wallet.name tpn_coldkey
   btcli w new_hotkey --wallet.name tpn_coldkey --wallet.hotkey tpn_hotkey
   ```

### 2: Register on Subnet
Registration costs TAO. Check current costs on [Taostats](https://taostats.io/subnets/65/registration).
```bash
btcli s register --wallet.name tpn_coldkey --hotkey tpn_hotkey --netuid 65
```
*(Use `--netuid 279` for testnet)*

## Running your Node

TPN nodes use a **Configuration-First** approach. One `.env` file controls both your Docker containers and your Python Neuron.

### 1: Configure your environment

```bash
cd ~/tpn-subnet/federated-container

# Copy the appropriate template for your role
cp .env.{miner|validator}.example .env

# Edit with your details
nano .env
```

#### Key Settings:
- `TPN_NETWORK`: Set to `finney` (Mainnet) or `test` (Testnet). This automatically sets the correct NetUID.
- `WALLET_NAME` / `HOTKEY_NAME`: Defaults to `tpn_coldkey` / `tpn_hotkey`.
- `MAXMIND_LICENSE_KEY` & `IP2LOCATION_DOWNLOAD_TOKEN`: Required for Miners/Validators.

> [!WARNING]
> **Validator Logging (WANDB)**: Weights & Biases (WANDB) is temporarily disabled as we migrate to a new core logging system. You do not need a WANDB key at this stage.

### 2: Launch the Node (Miner/Validator Only)

For Miners and Validators, launch is a simple two-step process:

**Step A: Start the Neuron (PM2)**
```bash
cd ~/tpn-subnet
pm2 start ecosystem.config.js
```

**Step B: Start the Federation (Docker)**
```bash
bash scripts/update_node.sh
```

---

## Running a Worker

A worker is the simplest node to run and only requires Docker.

1. Set up your `.env` in `federated-container/` using the worker template.
2. Start the worker:
```bash
bash ~/tpn-subnet/scripts/update_node.sh
```

## Operations & Maintenance

### Updating your Node
To update your node to the latest version, simply run the update script again. It will pull the latest code and restart services as needed:
```bash
bash ~/tpn-subnet/scripts/update_node.sh
```

### Checking Status
- **Neuron**: `pm2 status` or `pm2 logs`
- **Docker**: `docker compose -f federated-container/docker-compose.yml ps`

### Paying your workers

How mining pools pay workers is up to them. We encourage innovation and experimentation. All workers have a configured EVM wallet address and/or Bittensor address on which they request payment. As a mining pool you can periodically call the worker performance endpoint on your machine to do the payments according to your protocols.

To get the worker performance and payment addresses:

- Set a `ADMIN_API_KEY` in your `.env`
- Call your pool machine with that API key and requested format like so:

```bash
# Set your details
ADMIN_API_KEY=your_key
SERVER_URL="http://your_public_ip:3000"

curl "$SERVER_URL/api/worker_performance?api_key=$ADMIN_API_KEY&format=json&group_by=ip"
```

For more details on reward structures, see our [Worker Payment Guide](#faq).

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
