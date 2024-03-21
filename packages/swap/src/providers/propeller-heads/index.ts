import Web3Eth from "web3-eth";
import { numberToHex, toBN } from "web3-utils";
import estimateGasList from "../../common/estimateGasList";
import {
  EVMTransaction,
  getQuoteOptions,
  MinMaxResponse,
  ProviderClass,
  ProviderFromTokenResponse,
  ProviderName,
  ProviderQuoteResponse,
  ProviderSwapResponse,
  ProviderToTokenResponse,
  QuoteMetaOptions,
  StatusOptions,
  StatusOptionsResponse,
  SupportedNetworkName,
  SwapQuote,
  TokenType,
  TransactionStatus,
  TransactionType,
} from "../../types";
import {
  DEFAULT_SLIPPAGE,
  FEE_CONFIGS,
  GAS_LIMITS,
  NATIVE_TOKEN_ADDRESS,
} from "../../configs";
import {
  PropellerHeadsResponseType,
  PropellerHeadsSwapResponse,
} from "./types";
import {
  getAllowanceTransactions,
  TOKEN_AMOUNT_INFINITY_AND_BEYOND,
} from "../../utils/approvals";
import { isEVMAddress } from "../../utils/common";

const supportedNetworks: {
  [key in SupportedNetworkName]?: { approvalAddress: string; chainId: string };
} = {
  [SupportedNetworkName.Ethereum]: {
    approvalAddress: "0x14f2b6ca0324cd2B013aD02a7D85541d215e2906",
    chainId: "1",
  },
  [SupportedNetworkName.Zksync]: {
    approvalAddress: "0xe832e655E4C3c36b2be5256915ECF8536a642f59",
    chainId: "324",
  },
};

const NetworkNamesToSupportedProppellerHeadsBlockchains: Partial<
  Record<SupportedNetworkName, string>
> = {
  [SupportedNetworkName.Ethereum]: "ethereum",
  [SupportedNetworkName.Zksync]: "zksync",
};

const BASE_URL = "https://partners.mewapi.io/propellerheads/v2";

class PropellerHeads extends ProviderClass {
  tokenList: TokenType[];

  network: SupportedNetworkName;

  web3eth: Web3Eth;

  name: ProviderName;

  fromTokens: ProviderFromTokenResponse;

  toTokens: ProviderToTokenResponse;

  constructor(web3eth: Web3Eth, network: SupportedNetworkName) {
    super(web3eth, network);
    this.name = ProviderName.propellerHeads;
    this.network = network;
    this.web3eth = web3eth;
    this.tokenList = [];
    this.fromTokens = {};
    this.toTokens = {};
  }

  init(tokenList: TokenType[]): Promise<void> {
    if (!PropellerHeads.isSupported(this.network)) return;
    tokenList.forEach((t) => {
      this.fromTokens[t.address] = t;
      if (!this.toTokens[this.network]) this.toTokens[this.network] = {};
      this.toTokens[this.network][t.address] = {
        ...t,
        networkInfo: {
          name: this.network,
          isAddress: (address: string) =>
            Promise.resolve(isEVMAddress(address)),
        },
      };
    });
  }

  static isSupported(network: SupportedNetworkName) {
    return Object.keys(supportedNetworks).includes(
      network as unknown as string
    );
  }

  getFromTokens() {
    return this.fromTokens;
  }

  getToTokens() {
    return this.toTokens;
  }

  getMinMaxAmount(): Promise<MinMaxResponse> {
    return Promise.resolve({
      minimumFrom: toBN("1"),
      maximumFrom: toBN(TOKEN_AMOUNT_INFINITY_AND_BEYOND),
      minimumTo: toBN("1"),
      maximumTo: toBN(TOKEN_AMOUNT_INFINITY_AND_BEYOND),
    });
  }

  private getPropellerHeadsSwap(
    options: getQuoteOptions,
    meta: QuoteMetaOptions,
    accurateEstimate: boolean
  ): Promise<PropellerHeadsSwapResponse | null> {
    if (
      !PropellerHeads.isSupported(
        options.toToken.networkInfo.name as SupportedNetworkName
      ) ||
      this.network !== options.toToken.networkInfo.name
    )
      return Promise.resolve(null);

    if (options.fromAddress.toLowerCase() !== options.toAddress.toLowerCase())
      return Promise.resolve(null);

    const body = {
      orders: [
        {
          sell_token: options.fromToken.address,
          buy_token: options.toToken.address,
          sell_amount: options.amount.toString(),
          origin_address: options.fromAddress,
        },
      ],
    };

    const params = new URLSearchParams({
      blockchain:
        NetworkNamesToSupportedProppellerHeadsBlockchains[this.network],
    });

    return fetch(`${BASE_URL}/solver/solve?${params.toString()}`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((res) => res.json())
      .then(async (response: PropellerHeadsResponseType) => {
        const transactions: EVMTransaction[] = [];
        if (options.fromToken.address !== NATIVE_TOKEN_ADDRESS) {
          const approvalTxs = await getAllowanceTransactions({
            infinityApproval: meta.infiniteApproval,
            spender: supportedNetworks[this.network].approvalAddress,
            web3eth: this.web3eth,
            amount: options.amount,
            fromAddress: options.fromAddress,
            fromToken: options.fromToken,
          });
          transactions.push(...approvalTxs);
        }
        transactions.push({
          from: options.fromAddress,
          gasLimit: GAS_LIMITS.swap,
          to: options.fromAddress,
          value: numberToHex(options.amount),
          data: response.solutions[0].call_data,
          type: TransactionType.evm,
        });
        if (accurateEstimate) {
          const accurateGasEstimate = await estimateGasList(
            transactions,
            this.network
          );
          if (accurateGasEstimate) {
            if (accurateGasEstimate.isError) return null;
            transactions.forEach((tx, idx) => {
              tx.gasLimit = accurateGasEstimate.result[idx];
            });
          }
        }
        return {
          transactions,
          toTokenAmount: toBN(response.solutions[0].orders[0].buy_amount),
          fromTokenAmount: toBN(response.solutions[0].orders[0].sell_amount),
        };
      })
      .catch((e) => {
        console.error(e);
        return null;
      });
  }

  getQuote(
    options: getQuoteOptions,
    meta: QuoteMetaOptions
  ): Promise<ProviderQuoteResponse | null> {
    return this.getPropellerHeadsSwap(options, meta, false).then(
      async (res) => {
        if (!res) return null;
        const response: ProviderQuoteResponse = {
          fromTokenAmount: res.fromTokenAmount,
          additionalNativeFees: toBN(0),
          toTokenAmount: res.toTokenAmount,
          provider: this.name,
          quote: {
            meta,
            options,
            provider: this.name,
          },
          totalGaslimit: res.transactions.reduce(
            (total: number, curVal: EVMTransaction) =>
              total + toBN(curVal.gasLimit).toNumber(),
            0
          ),
          minMax: await this.getMinMaxAmount(),
        };
        return response;
      }
    );
  }

  getSwap(quote: SwapQuote): Promise<ProviderSwapResponse | null> {
    return this.getPropellerHeadsSwap(quote.options, quote.meta, true).then(
      (res) => {
        if (!res) return null;
        const feeConfig =
          FEE_CONFIGS[this.name][quote.meta.walletIdentifier].fee || 0;
        const response: ProviderSwapResponse = {
          fromTokenAmount: res.fromTokenAmount,
          additionalNativeFees: toBN(0),
          provider: this.name,
          toTokenAmount: res.toTokenAmount,
          transactions: res.transactions,
          slippage: quote.meta.slippage || DEFAULT_SLIPPAGE,
          fee: feeConfig * 100,
          getStatusObject: async (
            options: StatusOptions
          ): Promise<StatusOptionsResponse> => ({
            options,
            provider: this.name,
          }),
        };
        return response;
      }
    );
  }

  getStatus(options: StatusOptions): Promise<TransactionStatus> {
    const promises = options.transactionHashes.map((hash) =>
      this.web3eth.getTransactionReceipt(hash)
    );
    return Promise.all(promises).then((receipts) => {
      // eslint-disable-next-line no-restricted-syntax
      for (const receipt of receipts) {
        if (!receipt || (receipt && !receipt.blockNumber)) {
          return TransactionStatus.pending;
        }
        if (receipt && !receipt.status) return TransactionStatus.failed;
      }
      return TransactionStatus.success;
    });
  }
}

export default PropellerHeads;
