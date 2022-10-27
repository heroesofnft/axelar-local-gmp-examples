'use strict';

const {
  getDefaultProvider,
  Contract,
  constants: { AddressZero, MaxUint256 },
  utils: { keccak256, defaultAbiCoder },
} = require('ethers');
const {
  utils: { deployContract },
} = require('@axelar-network/axelar-local-dev');
const { deployUpgradable } = require('@axelar-network/axelar-gmp-sdk-solidity');

const HeroesToken = require('../../artifacts/examples/hro/HeroesToken.sol/HeroesToken.json');
const HeroesTokenRemote = require('../../artifacts/examples/hro/HeroesTokenRemote.sol/HeroesTokenRemote.json');
const HeroesTokenLinker = require('../../artifacts/examples/hro/HeroesTokenLinker.sol/HeroesTokenLinker.json');
const TokenLinkerProxy = require('../../artifacts/examples/hro/TokenLinkerProxy.sol/TokenLinkerProxy.json');
const NftLinkerProxy = require('../../artifacts/examples/hro/NftLinkerProxy.sol/NftLinkerProxy.json');

const IAxelarGateway = require('../../artifacts/@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IAxelarGateway.sol/IAxelarGateway.json');

async function deploy(chain, wallet) {
  console.log(`Deploying Whrm for ${chain.name}.`);

  const gateway = new Contract(chain.gateway, IAxelarGateway.abi, wallet);

  const provider = getDefaultProvider(chain.rpc);

  let heroesToken;
  // Select Avalanche as the main source chain
  // todo: in future this has to be `Hero`
  if (chain.name === 'Avalanche') {
    heroesToken = await deployContract(wallet, HeroesToken, []);
  }
  // Other chains are only remote
  else {
    heroesToken = await deployContract(wallet, HeroesTokenRemote, []);
  }

  const linkerContract = await deployUpgradable(
    chain.constAddressDeployer,
    wallet.connect(provider),
    HeroesTokenLinker,
    NftLinkerProxy,
    [chain.gateway, chain.gasReceiver],
    [],
    defaultAbiCoder.encode(['string', 'address'], [chain.name, heroesToken.address]),
    'hrolinker',
  );

  chain.hrotoken = heroesToken.address;
  chain.hrolinker = linkerContract.address;
  console.log(`Deployed HRO Token for ${chain.name} at ${chain.hrotoken}`);
  console.log(`Deployed HRO Token Linker for ${chain.name} at ${chain.hrolinker}`);

  console.log('hro address: ', await linkerContract.tokenAddress(), 'vs', heroesToken.address);
  console.log('chain name: ', await linkerContract.chainName(), 'vs', chain.name);
  console.log('gasService: ', await linkerContract.gasService(), 'vs', chain.gasReceiver);
  console.log('gateway: ', await linkerContract.gateway(), 'vs', chain.gateway);
}

async function test(chains, wallet, options) {
  const args = options.args || [];
  const getGasPrice = options.getGasPrice;
  for (const chain of chains) {
    const provider = getDefaultProvider(chain.rpc);
    chain.wallet = wallet.connect(provider);

    const gateway = new Contract(chain.gateway, IAxelarGateway.abi, wallet);

    console.log('HRO Token has already been deployed in', chain.name, ':', chain.hrotoken);

    //chain.hrotokencontract = await deployContract(chain.wallet, WhrmToken, []);
    chain.hrotokencontract = new Contract(chain.hrotoken, HeroesToken.abi, chain.wallet);

    chain.hrolinkercontract = await deployUpgradable(
      chain.constAddressDeployer,
      wallet.connect(provider),
      HeroesTokenLinker,
      NftLinkerProxy,
      [chain.gateway, chain.gasReceiver],
      [],
      defaultAbiCoder.encode(['string', 'address'], [chain.name, chain.hrotoken]),
      'hrolinker',
    );

    console.log(chain.name, 'hro linker contract deployed:', chain.hrolinkercontract.address);
  }

  const source = chains.find((chain) => chain.name === (args[0] || 'Avalanche'));
  const destination = chains.find((chain) => chain.name === (args[1] || 'Fantom'));

  // token id 1 / default
  const tokenId = parseInt(args[2]) || 1;
  const mintedAmount = 5;

  async function print() {
    try {
      const sourceOwnerOf = await source.hrotokencontract.ownerOf(tokenId);

      console.log(`In ${source.name} owner of ${tokenId} is ${sourceOwnerOf}`);

      const destinationOwnerOf = await destination.hrotokencontract.ownerOf(tokenId);

      console.log(`In ${destination.name} owner of ${tokenId} is ${destinationOwnerOf}`);
    } catch (error) {
      console.log('ERROR: ', error.reason);
    }
  }
  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  // Set the gasLimit to 5e5 (a safe overestimate) and get the gas price (this is constant and always 1).
  const gasLimit = 500000;
  const gasPrice = await getGasPrice(source, destination, AddressZero);

  console.log('\n\n');
  console.log('--- INITIALLY ---');
  await print();

  // Give roles to linker contracts to mint & burn
  for (const chain of chains) {
    const bridgeRole = keccak256(Buffer.from('BRIDGE_ROLE', 'utf-8'));

    // Pass the source chain
    if (chain.name === 'Avalanche') {
      continue;
    }
    console.log(chain.name);

    await (
      await chain.hrotokencontract.grantRole(bridgeRole, chain.hrolinkercontract.address, {
        gasLimit: gasLimit,
      })
    ).wait();
    console.log('giving bridge role to token linker contract');
    await sleep(500);

    console.log(chain.name, 'linker has minter role: ', await chain.hrotokencontract.hasRole(bridgeRole, chain.hrolinkercontract.address));
    await sleep(500);
  }

  await sleep(2000);

  console.log('giving approval to token linker contract');

  let tx = await source.hrotokencontract.approve(source.hrolinkercontract.address, tokenId, {
    gasLimit: 500000,
  });
  let receipt = await tx.wait();

  await sleep(3000);
  console.log('sending token: ');

  console.log('########################');
  try {
    tx = await source.hrolinkercontract.sendNft(destination.name, wallet.address, tokenId, wallet.address, {
      value: BigInt(Math.floor(gasLimit * gasPrice)),
      gasLimit: gasLimit * 20,
    });

    let receipt = await tx.wait();
    console.log('Transaction status: ', receipt.status);
  } catch (error) {
    console.log('');
    console.log('ERROR !');
    console.log(error);
  }

  await sleep(4000);

  console.log('');
  console.log('--- After ---');
  await print();
}

module.exports = {
  deploy,
  test,
};
