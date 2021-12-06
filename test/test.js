const et = require('euler-contracts/test/lib/eTestLib.js').config(`${__dirname}/lib/eTestLib.config.js`);
const { provisionUniswapPool, deposit, deployBot } = require('./lib/helpers');

et.testSet({
    desc: "liquidation",
    fixture: "testing-real-uniswap-activated",

    preActions: ctx => [
        // deployBot(ctx),

        { action: 'setIRM', underlying: 'WETH', irm: 'IRM_ZERO', },
        { action: 'setIRM', underlying: 'TST', irm: 'IRM_ZERO', },
        { action: 'setIRM', underlying: 'TST2', irm: 'IRM_ZERO', },
        { action: 'setAssetConfig', tok: 'WETH', config: { borrowFactor: .4}, },
        { action: 'setAssetConfig', tok: 'TST', config: { borrowFactor: .4}, },
        { action: 'setAssetConfig', tok: 'TST2', config: { borrowFactor: .4}, },

        // wallet is lender and liquidator
        ...deposit(ctx, 'TST'),
        ...deposit(ctx, 'WETH'),

        // wallet2 is borrower/violator
        ...deposit(ctx, 'TST2', ctx.wallet2),
        { from: ctx.wallet2, send: 'markets.enterMarket', args: [0, ctx.contracts.tokens.TST2.address], },

        // wallet 5 is the super whale
        ...provisionUniswapPool(ctx, 'TST/WETH', ctx.wallet5, et.eth(1000)),
        ...provisionUniswapPool(ctx, 'TST2/WETH', ctx.wallet5, et.eth(1000)),
        ...provisionUniswapPool(ctx, 'TST3/WETH', ctx.wallet5, et.eth(1000)),

        // initial prices
        { from: ctx.wallet5, action: 'doUniswapSwap', tok: 'TST', dir: 'buy', amount: et.eth(10_000), priceLimit: 2.2, },
        { from: ctx.wallet5, action: 'doUniswapSwap', tok: 'TST2', dir: 'sell', amount: et.eth(10_000), priceLimit: 0.4 },
        { from: ctx.wallet5, action: 'doUniswapSwap', tok: 'TST3', dir: 'buy', amount: et.eth(10_000), priceLimit: 1.7 },

        // wait for twap
        { action: 'checkpointTime', },
        { action: 'jumpTimeAndMine', time: 3600 * 30 },
    ],
})


.test({
    desc: "basic full liquidation",
    actions: ctx => [
        { from: ctx.wallet2, send: 'dTokens.dTST.borrow', args: [0, et.eth(5)], },

        { callStatic: 'exec.liquidity', args: [ctx.wallet2.address], onResult: r => {
            et.equals(r.collateralValue / r.liabilityValue, 1.09, 0.01);
        }, },

        { call: 'tokens.TST.balanceOf', args: [ctx.wallet5.address], onResult: r => {
            console.log('TST: ', r.toString());
        }},
        { from: ctx.wallet5, action: 'doUniswapSwap', tok: 'TST', dir: 'buy', amount: et.eth(10_000), priceLimit: 2.5 },
        { call: 'tokens.TST.balanceOf', args: [ctx.wallet5.address], onResult: r => {
            console.log('TST: ', r.toString());
        }},

        { callStatic: 'exec.getPriceFull', args: [ctx.contracts.tokens.TST.address], onResult: r => {
            console.log('price: ', et.formatUnits(r.twap));
        }},

        { action: 'checkpointTime', },
        { action: 'jumpTimeAndMine', time: 3600 * 30 * 100 },

        { callStatic: 'exec.liquidity', args: [ctx.wallet2.address], onResult: r => {
            et.equals(r.collateralValue / r.liabilityValue, 0.96, 0.001);
        }, },

        { callStatic: 'liquidation.checkLiquidation', args: [ctx.wallet.address, ctx.wallet2.address, ctx.contracts.tokens.TST.address, ctx.contracts.tokens.TST2.address],
            onResult: r => {
                et.equals(r.healthScore, 0.96, 0.001);
                ctx.stash.repay = r.repay;
                console.log('r.repay: ', r.repay.toString());
                ctx.stash.yield = r.yield;
                console.log('r.yield: ', r.yield.toString());
            },
        },

        { send: 'liquidationBot.liquidate', args: [async () => ({
            eulerAddr: ctx.contracts.euler.address,
            liquidationAddr: ctx.contracts.liquidation.address,
            execAddr: ctx.contracts.exec.address,
            swapAddr: ctx.contracts.swap.address,

            swapPath: await ctx.encodeUniswapPath(['TST2/WETH', 'TST/WETH'], 'TST2', 'TST', true),

            violator: ctx.wallet2.address,
            underlying: ctx.contracts.tokens.TST.address,
            collateral: ctx.contracts.tokens.TST2.address,
        })], },

        { call: 'eTokens.eTST.balanceOfUnderlying', args: [ctx.contracts.liquidationBot.address], onResult: r => {
            console.log('TST: ', r.toString());
        }},
        { call: 'eTokens.eTST2.balanceOfUnderlying', args: [ctx.contracts.liquidationBot.address], onResult: r => {
            console.log('TST2: ', r.toString());
        }},

        { call: 'eTokens.eTST.balanceOf', args: [ctx.contracts.liquidationBot.address], onResult: r => {
            console.log('eTST: ', r.toString());
        }},
        { call: 'eTokens.eTST2.balanceOf', args: [ctx.contracts.liquidationBot.address], onResult: r => {
            console.log('eTST2: ', r.toString());
        }},

        { callStatic: 'liquidation.checkLiquidation', args: [ctx.wallet.address, ctx.wallet2.address, ctx.contracts.tokens.TST.address, ctx.contracts.tokens.TST2.address],
            onResult: r => {
                et.equals(r.healthScore, 1.25, 0.001);
            },
        },

    ]
})


.run();

