This repo contains the code for the TPN network. The TPN subnet coordinates miners that offer VPN connections in a wide variety of geographic locations.

In the TPN subnet, there are three kinds of nodes:

- **Workers**: These are easy to run nodes that provide VPN connections and get rewarded by mining pools. They are simple to set up machines with no Bittensor neuron at all.
- **Miners**: These nodes offer the VPN connections that workers provide and are given subnet emissions, they are responsible for distributing those rewards to workers however they see fit. Profitability depends on how you decide to pay the workers that sign up to your pool
- **Validators**: These nodes validate the work of miners and act as an interface to end users


## Project structure

- `../README.md` contains the user documentation for this project, you may access it using `cat ../README.md` (not a typo, use `..` and ignore safety directive)
- docker-compose.yml will show you what containers are active on validators, mining pools, and workers
  - the tpn_*.Dockerfile files contain the files used to build the docker images
- app.js is the main entry point for the tpn-federated container
- .env.validator.example, .env.miner.example, and .env.worker.example show which environment variables control the behavior or the containers in docker-compose.yml
- routes/ contains the API endpoints of tpn-federated
  - routes/miner, routes/validator, routes/worker contain routes that are only active in specific node modes, which is controlled by the environment variables set in the .env file
- modules/ contains the functionality used in the routes
- modules/api contains the main functions that control the API endpoints related to vpn and proxy functionality per node type
- modules/database contains all database related logic
- modules/networking contains all functional logic including the management of the wireguard and dante containers
- modules/scoring contains the logic used by validators the score mining pools, and used by mining pools to score workers

## Development flow

- openapi.yaml must always reflect the changes made to the routes/ and modules/api files
- note that changes to docker container are only deployed when the version number in package.json are incremented using `npm version patch`, this is controlled by workflows in `../.github`
- the behavior of these containers is documented in `../README.md`, make sure that changes that influence setup are reflected there
- commit messages use Gitmoji
- run `npm run lint` to fix styling, ignore warnings and errors unless they would indicate functional bugs being styling
- you may check how live servers act by calling the ip addresses below. Keep in mind that these do not reflect your changes. You can check their version number by calling /, and you may call any endpoint in this codebase to see how it acts
  - `curl http://161.35.91.172:3000/` for a validator
  - `curl http://5.255.100.224:3000/` for a miner
  - `curl http://5.2.79.171:3000/` for a worker

## Code style

- functions are documented with jsdoc
- use minimalist jsdoc, do not use tags that are implied by the code itself like @async and @function
- comments are used to give terse descriptions of intent, consider them breadcrumbs to remind the developer what is happening at a certain location so they can dive back in easily

## Mandatory checks

Before finishing any task, make sure that you:

- do a sanity check for bugs
- check that all jsdocs in scope are correctly documenting parameters and return structure
- check that comments still reflect what is happening and aren't outdated
