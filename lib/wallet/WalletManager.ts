import fs from 'fs';
import bip39 from 'bip39';
import bip32, { BIP32 } from 'bip32';
import { Network } from 'bitcoinjs-lib';
import Errors from './Errors';
import Wallet from './Wallet';
import Logger from '../Logger';
import Database from '../db/Database';
import { WalletInfo } from '../consts/Types';
import UtxoRepository from './UtxoRepository';
import { splitDerivationPath } from '../Utils';
import ChainClient from '../chain/ChainClient';
import LndClient from '../lightning/LndClient';
import WalletRepository from './WalletRepository';
import OutputRepository from './OutputRepository';

type Currency = {
  symbol: string;
  network: Network;
  chainClient: ChainClient;
  lndClient: LndClient;
};

class WalletManager {
  public wallets = new Map<string, Wallet>();

  private masterNode: BIP32;
  private repository: WalletRepository;

  private utxoRepository: UtxoRepository;
  private outputResository: OutputRepository;

  private readonly derivationPath = 'm/0';

  /**
   * WalletManager initiates multiple HD wallets
   */
  constructor(private logger: Logger, private currencies: Currency[], db: Database, mnemonicPath: string) {
    this.masterNode = bip32.fromBase58(this.loadMnemonic(mnemonicPath));

    this.repository = new WalletRepository(db.models);
    this.utxoRepository = new UtxoRepository(db.models);
    this.outputResository = new OutputRepository(db.models);
  }

  /**
   * Initiates a new WalletManager with a mnemonic
   */
  public static fromMnemonic = (logger: Logger, mnemonic: string, mnemonicPath: string, currencies: Currency[], db: Database) => {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw(Errors.INVALID_MNEMONIC(mnemonic));
    }

    fs.writeFileSync(mnemonicPath, bip32.fromSeed(bip39.mnemonicToSeed(mnemonic)).toBase58());

    return new WalletManager(logger, currencies, db, mnemonicPath);
  }

  public init = async () => {
    const walletsMap = await this.getWalletsMap();

    for (const currency of this.currencies) {
      let walletInfo = walletsMap.get(currency.symbol);

      const { blocks } = await currency.chainClient.getBlockchainInfo();

      // Generate a new sub-wallet if that currency doesn't have one yet
      if (!walletInfo) {
        walletInfo = {
          derivationPath: `${this.derivationPath}/${this.getHighestDepthIndex(2, walletsMap) + 1}`,
          highestUsedIndex: 0,
          blockheight: blocks,
        };

        walletsMap.set(currency.symbol, walletInfo);

        await this.repository.addWallet({
          ...walletInfo,
          symbol: currency.symbol,
        });
      }

      const wallet = new Wallet(
        this.logger,
        this.repository,
        this.outputResository,
        this.utxoRepository,
        this.masterNode,
        currency.network,
        currency.chainClient,
        walletInfo.derivationPath,
        walletInfo.highestUsedIndex,
      );

      await wallet.init(walletInfo.blockheight);

      this.wallets.set(currency.symbol, wallet);
    }
  }

  private loadMnemonic = (filename: string): string => {
    if (fs.existsSync(filename)) {
      return fs.readFileSync(filename, 'utf-8');
    }

    throw(Errors.NOT_INITIALIZED());
  }

  private getWalletsMap = async() => {
    const map = new Map<string, WalletInfo>();
    const wallets = await this.repository.getWallets();

    wallets.forEach((wallet) => {
      map.set(wallet.symbol, {
        derivationPath: wallet.derivationPath,
        highestUsedIndex: wallet.highestUsedIndex,
        blockheight: wallet.blockheight,
      });
    });

    return map;
  }

  private getHighestDepthIndex = (depth: number, map: Map<string, WalletInfo>): number => {
    if (depth === 0) {
      throw(Errors.INVALID_DEPTH_INDEX(depth));
    }

    let highestIndex = -1;

    map.forEach((info) => {
      const split = splitDerivationPath(info.derivationPath);
      const index = split.sub[depth - 1];

      if (index > highestIndex) {
        highestIndex = index;
      }
    });

    return highestIndex;
  }
}

export default WalletManager;
export { Currency };
