module.exports = {
  localhost: {
    eulerscan: {
      ws: 'ws://localhost:8900',
    }
  },
  ropsten: {
    chainId: 3,
    jsonRpcUrl: process.env.ROPSTEN_JSON_RPC_URL,
    eulerscan: {
      ws: process.env.EULERSCAN_WS || 'wss://escan-ropsten.euler.finance',
      queryLimit: process.env.QUERY_LIMIT ? Number(process.env.QUERY_LIMIT) : 500,
      healthMax: process.env.QUERY_HEALTH_MAX ? Number(process.env.QUERY_HEALTH_MAX) : 1000000,
    },
    minYield: process.env.MIN_ETH_YIELD || '0.05',
    skipInsufficientCollateral: process.env.SKIP_ACCOUNTS_WITH_INSUFFICIENT_COLLATERAL === 'true',
  },
  goerli: {
    chainId: 5,
    jsonRpcUrl: process.env.GOERLI_JSON_RPC_URL,
    eulerscan: {
      ws: process.env.EULERSCAN_WS || 'wss://escan-goerli.euler.finance',
      queryLimit: process.env.QUERY_LIMIT ? Number(process.env.QUERY_LIMIT) : 500,
      healthMax: process.env.QUERY_HEALTH_MAX ? Number(process.env.QUERY_HEALTH_MAX) : 1000000,
    },
    minYield: process.env.MIN_ETH_YIELD || '0.05',
    skipInsufficientCollateral: process.env.SKIP_ACCOUNTS_WITH_INSUFFICIENT_COLLATERAL === 'true',
  },
  mainnet: {
    chainId: 1,
    jsonRpcUrl: process.env.MAINNET_JSON_RPC_URL,
    eulerscan: {
      ws: process.env.EULERSCAN_WS || 'wss://escan-mainnet.euler.finance',
      queryLimit: process.env.QUERY_LIMIT ? Number(process.env.QUERY_LIMIT) : 500,
      healthMax: process.env.QUERY_HEALTH_MAX ? Number(process.env.QUERY_HEALTH_MAX) : 1000000,
    },
    reporter: {
      interval: process.env.REPORTER_INTERVAL ? Number(process.env.REPORTER_INTERVAL) : 60 * 60,
      logPath: process.env.REPORTER_LOG_PATH || './log.txt',
    },
    minYield: process.env.MIN_ETH_YIELD || '0.05',
    skipInsufficientCollateral: process.env.SKIP_ACCOUNTS_WITH_INSUFFICIENT_COLLATERAL === 'true',
  },
  hardhat: {
    jsonRpcUrl: "http://localhost:8545",
    minYield: process.env.MIN_ETH_YIELD || '0.05',
  }
}
