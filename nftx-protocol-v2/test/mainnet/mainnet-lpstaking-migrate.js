const { expect } = require("chai");
const { expectRevert, expectException } = require("../../utils/expectRevert");

const { BigNumber } = require("@ethersproject/bignumber");
const { ethers, upgrades } = require("hardhat");

const addresses = require("../../addresses/rinkeby.json");
const { zeroPad } = require("ethers/lib/utils");

const BASE = BigNumber.from(10).pow(18);
const zeroAddr = "0x0000000000000000000000000000000000000000";
const notZeroAddr = "0x000000000000000000000000000000000000dead";

let primary, alice, bob, kiwi;
let dao;

let nftx;
let zap;
let staking;
let erc721;
let feeDistrib;
let controller;
let liveBugUser;
const vaults = [];

describe("LP Staking Upgrade Migrate Test", function () {
  before("Setup", async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_MAINNET_API_KEY}`,
            blockNumber: 12916031,
          },
        },
      ],
    });

    signers = await ethers.getSigners();
    primary = signers[0];
    alice = signers[1];
    bob = signers[2];

    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x08D816526BdC9d077DD685Bd9FA49F58A5Ab8e48"],
    });
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x40d73df4f99bae688ce3c23a01022224fe16c7b2"],
    });
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x8B0C8c18993a31F57e60d81761F532Ef14633153"],
    });
    
    kiwi = await ethers.provider.getSigner(
      "0x08D816526BdC9d077DD685Bd9FA49F58A5Ab8e48"
    );
    dao = await ethers.provider.getSigner(
      "0x40d73df4f99bae688ce3c23a01022224fe16c7b2"
    );
    liveBugUser = await ethers.provider.getSigner(
      "0x8B0C8c18993a31F57e60d81761F532Ef14633153"
    );

    nftx = await ethers.getContractAt(
      "NFTXVaultFactoryUpgradeable",
      "0xBE86f647b167567525cCAAfcd6f881F1Ee558216"
    );
    staking = await ethers.getContractAt(
      "NFTXLPStaking",
      "0x688c3E4658B5367da06fd629E41879beaB538E37"
    );
    controller = await ethers.getContractAt(
      "ProxyController",
      "0x4333d66Ec59762D1626Ec102d7700E64610437Df"
    );

    let Zap = await ethers.getContractFactory("NFTXStakingZap");

    zap = await Zap.deploy(
      "0xBE86f647b167567525cCAAfcd6f881F1Ee558216",
      "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F" /* Sushi Router */
    );
    await zap.deployed();

    await nftx.connect(dao).setZapContract(zap.address);
  });

  it("Should exclude the zap from fees", async () => {
    await nftx.connect(dao).setFeeExclusion(zap.address, true);
  })

  it("Should set state fields", async () => {
    expect(await zap.nftxFactory()).to.equal(nftx.address);
    expect(await zap.lpStaking()).to.equal(staking.address);
    expect(await zap.sushiRouter()).to.equal(
      "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F"
    );
  });

  it("Should fail claim rewards for live user", async () => {
    await expectRevert(staking.connect(liveBugUser).claimRewards(49));
  });

  it("Should upgrade the LP staking", async () => {
    let NewStaking = await ethers.getContractFactory("NFTXLPStaking");
    let newStaking = await NewStaking.deploy();
    await newStaking.deployed();
    await controller.connect(dao).upgradeProxyTo(3, newStaking.address);
    await staking.assignNewImpl();
  });

  it("Should let live bug user migrate without claiming normally", async () => {
    let unusedDisttoken = await staking.unusedRewardDistributionToken(49);
    let address = await nftx.vault(49);
    let vaultToken = await ethers.getContractAt("IERC20Upgradeable", address)
    let oldBal = await vaultToken.balanceOf(unusedDisttoken);
    await staking.connect(liveBugUser).emergencyMigrate(49);
    let newBal = await vaultToken.balanceOf(unusedDisttoken);
    expect(newBal).to.equal(oldBal);
  })

  it("Should distribute current new rewards to treasury for undeployed pool", async () => {
    const waifuVaultAddr = await nftx.vault(10);
    const waifuVault = await ethers.getContractAt("NFTXVaultUpgradeable", waifuVaultAddr);
    vaults.push(waifuVault);
    let oldBal = await waifuVault.balanceOf("0x40D73Df4F99bae688CE3C23a01022224FE16C7b2");
    await waifuVault.connect(liveBugUser).mint([296], []);
    let newBal = await waifuVault.balanceOf("0x40D73Df4F99bae688CE3C23a01022224FE16C7b2");
    expect(oldBal).to.not.equal(newBal);
  });

  it("Should let live bug user migrate to undeployed pool", async () => {
    await staking.connect(liveBugUser).emergencyMigrate(10);
  })

  it("Should distribute current new rewards to new LP token", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(10);
    let oldBal = await vaults[0].balanceOf(newDisttoken);
    await vaults[0].connect(liveBugUser).mint([326], []);
    let newBal = await vaults[0].balanceOf(newDisttoken);
    expect(oldBal).to.not.equal(newBal);
  });

  it("Should let user claim rewards from new pool", async () => {
    let oldBal = await vaults[0].balanceOf(liveBugUser.getAddress());
    await staking.connect(liveBugUser).claimRewards(10);
    let newBal = await vaults[0].balanceOf(liveBugUser.getAddress());
    expect(oldBal).to.not.equal(newBal);
  });


  let lpTokenAmount;
  it("Should add liquidity with 721 on existing pool", async () => {
    vault = await ethers.getContractAt(
      "NFTXVaultUpgradeable",
      "0x114f1388fab456c4ba31b1850b244eedcd024136"
    );
    vaults.push(vault);
    const assetAddress = await vaults[1].assetAddress();
    const coolCats = await ethers.getContractAt("ERC721", assetAddress);
    await coolCats.connect(kiwi).setApprovalForAll(zap.address, true);

    const router = await ethers.getContractAt("IUniswapV2Router01", "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F");
    const pair = await ethers.getContractAt("IUniswapV2Pair", "0x0225e940deecc32a8d7c003cfb7dae22af18460c")
    const preDepositBal = await pair.balanceOf(staking.address);
    const {
      reserve0,
      reserve1,
    } = await pair.getReserves();
    const amountToLP = BASE.mul(2); //.sub(mintFee.mul(5)) no fee anymore
    const amountETH = await router.quote(amountToLP, reserve0, reserve1)
    await vaults[1].connect(kiwi).approve(zap.address, BASE.mul(1000))
    await zap.connect(kiwi).addLiquidity721ETH(31, [184,5916], amountETH.sub(500), {value: amountETH})
    const postDepositBal = await pair.balanceOf(staking.address);
    lpTokenAmount = postDepositBal.sub(preDepositBal)
  });

  it("Should have locked balance", async () => {
    const locked = await zap.lockedUntil(31, kiwi.getAddress());
    expect(await zap.lockedLPBalance(31, kiwi.getAddress())).to.equal(
      lpTokenAmount.toString()
    );
    expect(locked).to.be.gt(1625729248);
  });

  it("Should mint to generate some rewards", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let oldBal = await vaults[1].balanceOf(newDisttoken);
    await vaults[1].connect(kiwi).mint([7356], [1]);
    let newBal = await vaults[1].balanceOf(newDisttoken);
    expect(oldBal).to.not.equal(newBal);
  })

  it("Should not allow to withdraw locked tokens before lock", async () => {
    await expectException(staking.connect(kiwi).exit(31), "User locked");
  });

  it("Should allow claiming rewards before unlocking", async () => {
    let oldBal = await vaults[1].balanceOf(kiwi.getAddress());
    await staking.connect(kiwi).claimRewards(31);
    let newBal = await vaults[1].balanceOf(kiwi.getAddress());
    expect(newBal).to.not.equal(oldBal);
  })
  
  it("Should pass some time", async () => {
    await ethers.provider.send("evm_increaseTime",  [24*60*60]);
    await ethers.provider.send("evm_mine", []);
  });

  it("Should not allow to withdraw locked tokens before lock", async () => {
    await expectException(staking.connect(kiwi).exit(31), "User locked");
  });

  it("Should not allow transfer before lock", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let distToken = await ethers.getContractAt("IERC20Upgradeable", newDisttoken)
    await expectException(distToken.connect(kiwi).transfer(dao.getAddress(), 1), "User locked");
  });

  it("Should pass some time", async () => {
    await ethers.provider.send("evm_increaseTime",  [24*60*60]);
    await ethers.provider.send("evm_mine", []);
  });

  it("Should distribute current new rewards to new LP token", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let oldBal = await vaults[1].balanceOf(newDisttoken);
    await vaults[1].connect(kiwi).mint([2581], [1]);
    let newBal = await vaults[1].balanceOf(newDisttoken);
    expect(oldBal).to.not.equal(newBal);
  });

  it("Should allow to exit and claim locked tokens after lock", async () => {
    let oldBal = await vaults[1].balanceOf(kiwi.getAddress());
    await staking.connect(kiwi).exit(31);
    let newBal = await vaults[1].balanceOf(kiwi.getAddress());
    expect(newBal).to.not.equal(oldBal);
    expect(await zap.lockedLPBalance(31, kiwi.getAddress())).to.equal(0);
  });

  it("Should allow to deposit again", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let distToken = await ethers.getContractAt("IERC20Upgradeable", newDisttoken)
    let oldBal = await distToken.balanceOf(kiwi.getAddress());
    await staking.connect(kiwi).deposit(31, lpTokenAmount);
    let newBal = await distToken.balanceOf(kiwi.getAddress());
    expect(newBal).to.not.equal(oldBal);
    expect(newBal).to.equal(lpTokenAmount);
    expect(await zap.lockedLPBalance(31, kiwi.getAddress())).to.equal(0);
  });

  it("Should let kiwi migrate to new pool", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let distToken = await ethers.getContractAt("IERC20Upgradeable", newDisttoken)
    let oldBal = await distToken.balanceOf(kiwi.getAddress());
    await staking.connect(kiwi).emergencyMigrate(31);
    let newBal = await distToken.balanceOf(kiwi.getAddress());
    expect(oldBal).to.not.equal(newBal);
  })

  it("Should mint to generate some rewards", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let oldBal = await vaults[1].balanceOf(newDisttoken);
    await vaults[1].connect(kiwi).mint([8912], [1])
    let newBal = await vaults[1].balanceOf(newDisttoken);
    expect(oldBal).to.not.equal(newBal);
  })

  it("Should let the user withdraw", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let distToken = await ethers.getContractAt("IERC20Upgradeable", newDisttoken)
    let oldBal = await distToken.balanceOf(kiwi.getAddress());
    await staking.connect(kiwi).withdraw(31, oldBal);
    let newBal = await distToken.balanceOf(kiwi.getAddress());
    expect(newBal).to.not.equal(oldBal);
  })

  it("Should allow claiming rewards after unlocking", async () => {
    let oldBal = await vaults[1].balanceOf(kiwi.getAddress());
    await staking.connect(kiwi).claimRewards(31);
    let newBal = await vaults[1].balanceOf(kiwi.getAddress());
    expect(oldBal).to.not.equal(newBal);
  })

  it("Should allow to deposit again", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let distToken = await ethers.getContractAt("IERC20Upgradeable", newDisttoken)
    let oldBal = await distToken.balanceOf(kiwi.getAddress());
    await staking.connect(kiwi).deposit(31, lpTokenAmount);
    let newBal = await distToken.balanceOf(kiwi.getAddress());
    expect(newBal).to.not.equal(oldBal);
    expect(newBal).to.equal(lpTokenAmount);
    expect(await zap.lockedLPBalance(31, kiwi.getAddress())).to.equal(0);
  });

  it("Should upgrade the vault contract", async () => {
    let NewVault = await ethers.getContractFactory("NFTXVaultUpgradeable");
    let newVault = await NewVault.deploy();
    await newVault.deployed();
    await nftx.connect(dao).upgradeChildTo(newVault.address);
  });

  it("Should save stuck fees", async () => {
    let newDisttoken = await staking.newRewardDistributionToken(31);
    let unusedDisttoken = await staking.unusedRewardDistributionToken(31);
    let oldNewBal = await vaults[1].balanceOf(newDisttoken);
    let oldUnusedBal = await vaults[1].balanceOf(unusedDisttoken);

    await vaults[1].connect(kiwi).saveStuckFees()

    let newNewBal = await vaults[1].balanceOf(newDisttoken);
    let newUnusedBal = await vaults[1].balanceOf(unusedDisttoken);
    expect(oldUnusedBal).to.not.equal(0);
    expect(newUnusedBal).to.equal(0);
    expect(newNewBal).to.not.equal(0);
    expect(newNewBal).to.equal(oldNewBal.add(oldUnusedBal));
  })

  it("Should allow claiming rewards after distributing", async () => {
    let oldBal = await vaults[1].balanceOf(kiwi.getAddress());
    await staking.connect(kiwi).claimRewards(31);
    let newBal = await vaults[1].balanceOf(kiwi.getAddress());
    expect(newBal).to.not.equal(oldBal);
  })
});
