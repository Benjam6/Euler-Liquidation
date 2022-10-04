let ethers = require('ethers');
let axios = require('axios');
let { FlashbotsBundleProvider, FlashbotsTransactionResolution } = require('@flashbots/ethers-provider-bundle');
let { cartesian, filterOutRejected, c1e18, txOpts } = require('../utils');
let { utils } = require('@eulerxyz/euler-sdk');

let FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY;
let ONEINCH_API_URL             = process.env.ONEINCH_API_URL;
let useFlashbots                = process.env.USE_FLASHBOTS === 'true';
let flashbotsMaxBlocks          = Number(process.env.FLASHBOTS_MAX_BLOCKS);
let flashbotsDisableFallback    = process.env.FLASHBOTS_DISABLE_FALLBACK === 'true';

let receiverSubAccountId        = Number(process.env.RECEIVER_SUBACCOUNT_ID);

let MAX_UINT    = ethers.constants.MaxUint256;
let formatUnits = ethers.utils.formatUnits;
let parseUnits  = ethers.utils.parseUnits;

class EOASwapAndRepay {
    constructor(act, collateral, underlying, euler, reporter) {
        this.act = act;
        this.euler = euler;
        this.violator = act.account;
        this.liquidator = euler.getSigner().address;
        this.receiver = receiverSubAccountId ? utils.getSubAccount(this.liquidator, receiverSubAccountId) : this.liquidator
        this.collateralAddr = collateral.underlying.toLowerCase();
        this.underlyingAddr = underlying.underlying.toLowerCase();
        this.refAsset = euler.referenceAsset.toLowerCase();
        this.best = null;
        this.name = 'EOASwapAndRepay';
        this.isProtectedCollateral = false;
        this.reporter = reporter || console;
    }

    async findBest() {
        let paths;
        let feeLevels = [100, 500, 3000, 10000];

        let protectedUnderlying
        try {
            protectedUnderlying = await this.euler.pToken(this.collateralAddr).underlying();
        } catch {}

        if (protectedUnderlying) {
            let u2p  = await this.euler.contracts.markets.underlyingToPToken(protectedUnderlying);
            if (this.collateralAddr.toLowerCase() === u2p.toLowerCase()) {
                this.isProtectedCollateral = true;
                this.unwrappedCollateralAddr = protectedUnderlying.toLowerCase();
                let unwrappedEToken = await this.euler.contracts.markets.underlyingToEToken(protectedUnderlying);
                this.unwrappedCollateralEToken = this.euler.eToken(unwrappedEToken);

                let allowance = await this.euler.erc20(this.unwrappedCollateralAddr).allowance(this.liquidator, this.euler.addresses.euler);
                if (allowance.eq(0)) {
                    await (await this.euler.erc20(this.unwrappedCollateralAddr).approve(
                        this.euler.addresses.euler,
                        MAX_UINT,
                        ({...await txOpts(this.euler.getProvider()), gasLimit: 300000})
                    )).wait();
                }
            }
        }

        this.finalCollateralAddr = this.isProtectedCollateral ? this.unwrappedCollateralAddr : this.collateralAddr;

        this.collateralEToken = await this.euler.eTokenOf(this.collateralAddr);
        this.collateralToken = this.euler.erc20(this.collateralAddr);
        this.collateralDecimals = await this.euler.erc20(this.finalCollateralAddr).decimals();
        this.underlyingEToken = await this.euler.eTokenOf(this.underlyingAddr);
        this.underlyingDecimals = await this.euler.erc20(this.underlyingAddr).decimals();

        let liqOpp = await this.euler.contracts.liquidation.callStatic.checkLiquidation(
            this.liquidator,
            this.violator,
            this.underlyingAddr,
            this.collateralAddr,
        );

        if (liqOpp.repay.eq(0)) return;

        if ([this.finalCollateralAddr, this.underlyingAddr].includes(this.refAsset)) {
            paths = feeLevels.map(fee => {
                return this.encodePath([this.underlyingAddr, this.finalCollateralAddr], [fee]);
            });
        } else {
            // TODO explosion! try auto router, sdk
            // TODO don't do combination if collateral is the same as underlying - burn conversion item
            paths = cartesian(feeLevels, feeLevels).map(([feeIn, feeOut]) => {
                return this.encodePath([this.underlyingAddr, this.refAsset, this.finalCollateralAddr], [feeIn, feeOut]);
            });
        }

        let repayFraction = 98;
        while (!this.best && repayFraction === 98) {
            let repay = liqOpp.repay.mul(repayFraction).div(100);
            let unwrapAmount;
            if (this.isProtectedCollateral) {
                unwrapAmount = await this.getYieldByRepay(repay);
            }

            let oneInchQuote
            if (this.underlyingAddr !== this.finalCollateralAddr) {
                try {
                    oneInchQuote = await this.getOneInchQuote(repay.div(ethers.BigNumber.from(10).pow(18 - this.underlyingDecimals)));
                } catch (e) {
                    console.log('e: ', e);
                    this.reporter.log({
                        type: this.reporter.ERROR,
                        account: this.act,
                        error: `Failed fetching 1inch quote`,
                        strategy: this.describe(),
                    });
                }
            }

            let tests = await Promise.allSettled(
                paths.map(async (path) => {
                    let yieldEth = await this.testLiquidation(path, repay, unwrapAmount, oneInchQuote)
                    return {
                        swapPath: path,
                        repay,
                        yield: yieldEth,
                        unwrapAmount,
                        oneInchQuote,
                    };
                })
            );

            // TODO retry failed or continue
            tests = filterOutRejected(tests, (i, err) => {
                // console.log(`EOASwapAndRepay failed test ${this.violator}, c: ${this.collateralAddr} u: ${this.underlyingAddr} path: ${paths[i]} error: ${err}`)
            })

            let best = tests.reduce((accu, t) => {
                return t.yield.gt(accu.yield) ? t : accu;
            }, { swapPath: null, yield: ethers.BigNumber.from(0) });


            this.best = best.yield.gt(0) ? best : null;

            repayFraction = Math.floor(repayFraction / 2);
        }
    }

    async exec() {
        if (!this.best) throw 'No opportunity found yet!';



        let execRegularTx = async () => {
            let batch = this.buildLiqBatch(this.best.swapPath, this.best.repay, this.best.unwrapAmount, this.best.oneInchQuote);

            return await (
                await this.euler.contracts.exec.batchDispatch(
                    this.euler.buildBatch(batch),
                    [this.liquidator],
                    ({...await txOpts(this.euler.getProvider()), gasLimit: 1200000})
                )
            ).wait();
        }

        if (useFlashbots) {
            try {
                let provider = this.euler.getProvider();
                let signer = this.euler.getSigner();
                let flashbotsRelaySigningWallet = FLASHBOTS_RELAY_SIGNING_KEY
                    ? new ethers.Wallet(FLASHBOTS_RELAY_SIGNING_KEY)
                    : ethers.Wallet.createRandom();

                let flashbotsProvider = await FlashbotsBundleProvider.create(
                    provider,
                    flashbotsRelaySigningWallet,
                    ...(this.euler.chainId === 5 ? ['https://relay-goerli.flashbots.net/', 'goerli'] : []),
                );

                let tx = await this.euler.contracts.exec.populateTransaction.batchDispatch(
                    this.euler.buildBatch(this.buildLiqBatch(this.best.swapPath, this.best.repay, this.best.unwrapAmount, this.best.oneInchQuote)),
                    [this.liquidator],
                    ({...await txOpts(provider), gasLimit: 1200000}),
                );

                tx = {
                    ...tx,
                    type: 2,
                    chainId: this.euler.chainId,
                    nonce: await provider.getTransactionCount(signer.address),
                };

                let blockNumber = await this.euler.getProvider().getBlockNumber();

                let signedTransaction = await signer.signTransaction(tx);
                let simulation = await flashbotsProvider.simulate(
                    [signedTransaction],
                    blockNumber + 1,
                );

                if (simulation.error) {
                    throw new Error(simulation.error.message);
                }
                if (simulation.firstRevert) {
                    throw new Error(`${simulation.firstRevert.error} ${simulation.firstRevert.revert}`);
                }

                let privateTx = {
                    transaction: tx,
                    signer,
                };
                let opts = flashbotsMaxBlocks > 0 
                    ? { maxBlockNumber: blockNumber + flashbotsMaxBlocks }
                    : {};
                let submission = await flashbotsProvider.sendPrivateTransaction(
                    privateTx, 
                    opts
                );

                if (submission.error) {
                    throw new Error(submission.error.message);
                }

                let txResolution = await submission.wait();

                if (txResolution !== FlashbotsTransactionResolution.TransactionIncluded) {
                    throw new Error('Transaction dropped');
                }

                return submission;
            } catch (e) {
                console.log('e: ', e);

                if (!flashbotsDisableFallback) {
                    this.reporter.log({
                        type: this.reporter.ERROR,
                        account: this.act,
                        error: `Flashbots error, falling back to regular tx. err: "${e}"`,
                        strategy: this.describe(),
                    });
                    await this.findBest();
                    return execRegularTx();
                } else {
                    throw e;
                }
            }
        }

        return execRegularTx();
    }

    describe() {
        return this.best
            ? `EOASwapAndRepay c: ${this.collateralAddr}, u: ${this.underlyingAddr}, repay: ${this.best.repay.toString()} `
                +`yield: ${ethers.utils.formatEther(this.best.yield)} ETH, path ${this.best.swapPath}`
            : 'EOASwapAndRepay: No opportunity found';
    }

    // PRIVATE

    buildLiqBatch(swapPath, repay, unwrapAmount, oneInchQuote) {
        let conversionItems = [];

        let collateralEToken = this.isProtectedCollateral ? this.unwrappedCollateralEToken : this.collateralEToken;

        if (this.isProtectedCollateral) {
            conversionItems.push(
                {
                    contract: this.collateralEToken,
                    method: 'withdraw',
                    args: [0, MAX_UINT],
                },
                {
                    contract: 'exec',
                    method: 'pTokenUnWrap',
                    args: [
                        this.unwrappedCollateralAddr,
                        unwrapAmount
                    ]
                },
                {
                    contract: this.unwrappedCollateralEToken,
                    method: 'deposit',
                    args: [0, MAX_UINT]
                },
            )
        }

        if (this.underlyingAddr === this.finalCollateralAddr) {
            // TODO test
            conversionItems.push(
                {
                    contract: collateralEToken,
                    method: 'burn',
                    args: [
                        0,
                        MAX_UINT,
                    ],
                }
            );
        } else {
            if (oneInchQuote) {
                conversionItems.push(
                    {
                        contract: 'swap',
                        method: 'swap1Inch',
                        args: [{
                            subAccountIdIn: 0,
                            subAccountIdOut: 0,
                            underlyingIn: this.finalCollateralAddr,
                            underlyingOut: this.underlyingAddr,
                            amount: oneInchQuote.amount,
                            amountOutMinimum: 0, // MAX SLIPPAGE!
                            payload: oneInchQuote.payload,
                        }]
                    },
                    {
                        contract: this.underlyingEToken,
                        method: 'burn',
                        args: [0, MAX_UINT],
                    },
                )
            }
            conversionItems.push(
                {
                    contract: 'swap',
                    method: 'swapAndRepayUni',
                    args: [
                        {
                            subAccountIdIn: 0,
                            subAccountIdOut: 0,
                            amountOut: 0,
                            amountInMaximum: MAX_UINT,
                            deadline: 0, // FIXME!
                            path: swapPath,
                        },
                        0,
                    ],
                },
            );
        }

        return [
            {
                contract: 'liquidation',
                method: 'liquidate',
                args: [
                    this.violator,
                    this.underlyingAddr,
                    this.collateralAddr,
                    repay,
                    0,
                ],
            },
            ...conversionItems,
            {
                contract: 'markets',
                method: 'exitMarket',
                args: [
                    0,
                    this.underlyingAddr,
                ],
            },
            ...(this.liquidator !== this.receiver
                ? [{
                    contract: this.collateralEToken,
                    method: 'transferFromMax',
                    args: [this.liquidator, this.receiver],
                  }]
                : []
            )
        ];
    }

    async testLiquidation(swapPath, repay, unwrapAmount, oneInchQuote) {
        const targetCollateralEToken = this.isProtectedCollateral ? this.unwrappedCollateralEToken : this.collateralEToken;

        let batchItems = [
            {
                contract: targetCollateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.receiver,
                ]
            },
            ...this.buildLiqBatch(swapPath, repay, unwrapAmount, oneInchQuote),
            {
                contract: 'exec',
                method: 'getPriceFull',
                args: [
                    this.collateralAddr,
                ],
            },
            {
                contract: targetCollateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.receiver,
                ],
            },
        ];
        let simulation, error;
        ({ simulation, error } = await this.euler.simulateBatch([this.liquidator], batchItems));
        if (error) throw error.value;

        let balanceBefore = simulation[0].response[0];
        let balanceAfter = simulation[simulation.length - 1].response[0];

        if (balanceAfter.lte(balanceBefore)) throw `No yield ${repay} ${swapPath}`;
        let yieldCollateral = balanceAfter.sub(balanceBefore);

        let yieldEth = yieldCollateral
            .mul(ethers.BigNumber.from(10).pow(18 - this.collateralDecimals))
            .mul(simulation[simulation.length - 2].response.currPrice).div(c1e18);

        return yieldEth;
    }

    encodePath(path, fees) {
        let FEE_SIZE = 3;

        if (path.length != fees.length + 1) {
            throw new Error('path/fee lengths do not match');
        }

        let encoded = '0x';
        for (let i = 0; i < fees.length; i++) {
            // 20 byte encoding of the address
            encoded += path[i].slice(2);
            // 3 byte encoding of the fee
            encoded += fees[i].toString(16).padStart(2 * FEE_SIZE, '0');
        }
        // encode the final token
        encoded += path[path.length - 1].slice(2);

        return encoded.toLowerCase();
    }

    async getYieldByRepay(repay) {
        let batch = [
            {
                contract: this.collateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.liquidator,
                ]
            },
            {
                contract: 'liquidation',
                method: 'liquidate',
                args: [
                    this.violator,
                    this.underlyingAddr,
                    this.collateralAddr,
                    repay,
                    0,
                ],
            },
            {
                contract: this.collateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.liquidator,
                ]
            },
        ];

        let { simulation } = await this.euler.simulateBatch([this.liquidator], batch);

        let balanceBefore = simulation[0].response[0];
        let balanceAfter = simulation[simulation.length - 1].response[0];

        return balanceAfter.sub(balanceBefore);
    }

    async getOneInchQuote(targetAmountOut) {
        if (!ONEINCH_API_URL) return;

        let getQuote = async amount => {
            let searchParams = new URLSearchParams({
                fromTokenAddress: this.finalCollateralAddr,
                toTokenAddress: this.underlyingAddr,
                amount: amount.toString(),
                disableEstimate: "true",
                fromAddress: this.euler.addresses.euler,
                allowPartialFill: "false",
                slippage: "50", // max slippage
            })

            let { data } = await axios.get(
                `${
                    ONEINCH_API_URL
                }?${searchParams.toString()}`,
            );

            return data;
        }

        let { toTokenAmount } = await getQuote(parseUnits('1', this.collateralDecimals));

        let amount = targetAmountOut
        if (this.collateralDecimals > this.underlyingDecimals) {
            amount = amount.mul(ethers.BigNumber.from('10').pow(this.collateralDecimals - this.underlyingDecimals));
        } else {
            amount = amount.div(ethers.BigNumber.from('10').pow(this.underlyingDecimals - this.collateralDecimals));
        }
        amount = amount
            .mul(parseUnits('1', this.underlyingDecimals))
            .div(toTokenAmount);

        if (amount.eq(0)) return;

        let cnt = 0;
        let quote;
        do {
            quote = await getQuote(amount);
            cnt++;
            amount = amount.mul(100 - cnt).div(100);

            if (cnt > 5) {
                throw new Error("Failed fetching quote in 6 iterations");
            }
        } while (targetAmountOut.lte(quote.toTokenAmount))

        return {
            amount: ethers.BigNumber.from(quote.fromTokenAmount),
            payload: quote.tx.data,
        }
    }
}

module.exports = EOASwapAndRepay;
