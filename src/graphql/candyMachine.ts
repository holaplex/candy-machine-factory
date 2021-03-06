import {
  arg,
  mutationField,
  nonNull,
  objectType,
  stringArg,
  booleanArg,
  queryField,
} from 'nexus';
import { YogaInitialContext } from 'graphql-yoga';
import { web3 } from '@project-serum/anchor';
import { uuid as uuidv4, isUuid } from 'uuidv4';
import path from 'path';
import fs from 'fs/promises';
import { getType } from 'mime';
import winston from 'winston';
import rimraf from 'rimraf';
import { uploadV2 } from '../../cli/commands/upload-logged.js';
import { decryptEncodedPayload } from '../lib/cryptography/utils.js';
import { loadCandyProgramV2 } from '../../cli/helpers/accounts.js';
import {
  getCandyMachineV2ConfigFromPayload,
  parseCollectionMintPubkey,
} from '../../cli/helpers/various.js';
import { StorageType } from '../../cli/helpers/storage-type.js';
import { download } from '../lib/helpers/downloadFile.js';
import { unzip } from '../lib/helpers/unZipFile.js';
import { CACHE_PATH, EXTENSION_JSON } from '../../cli/helpers/constants.js';
import mkdirp from 'mkdirp';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes/index.js';
import retry from 'async-retry';

const dirname = path.resolve();

const runUploadV2 = async (
  logger: winston.Logger,
  processId: string,
  args: {
    collectionMint: string;
    config: any;
    callbackUrl: null | string;
    guid?: string;
    keyPair: string;
    env: string;
    filesZipUrl: string;
    rpc: string;
    setCollectionMint: boolean;
  },
) => {
  const {
    collectionMint: collectionMintParam,
    setCollectionMint,
    filesZipUrl,
    config,
    rpc,
    env,
    keyPair,
  } = args;
  logger.log('info', 'Before start...');
  const collectionMint = new web3.PublicKey(collectionMintParam);
  await retry(
    async (bail) => {
      try {
        logger.info('Starting...');
        const bytes = bs58.decode(keyPair);
        const walletKeyPair = web3.Keypair.fromSecretKey(
          Uint8Array.from(bytes),
        );

        const anchorProgram = await loadCandyProgramV2(walletKeyPair, env, rpc);

        const {
          storage,
          nftStorageKey,
          nftStorageGateway,
          ipfsInfuraProjectId,
          number,
          ipfsInfuraSecret,
          pinataJwt,
          pinataGateway,
          arweaveJwk,
          awsS3Bucket,
          retainAuthority,
          mutable,
          batchSize,
          price,
          splToken,
          treasuryWallet,
          gatekeeper,
          endSettings,
          hiddenSettings,
          whitelistMintSettings,
          goLiveDate,
          uuid,
        } = await getCandyMachineV2ConfigFromPayload(
          walletKeyPair,
          anchorProgram,
          config,
        );

        if (storage === StorageType.ArweaveSol && env !== 'mainnet-beta') {
          logger.warn(
            'WARNING: On Devnet, the arweave-sol storage option only stores your files for 1 week. Please upload via Mainnet Beta for your final collection.',
          );
        }

        if (storage === StorageType.ArweaveBundle && env !== 'mainnet-beta') {
          bail(
            new Error(
              'The arweave-bundle storage option only works on mainnet because it requires spending real AR tokens. For devnet, please set the --storage option to "aws" or "ipfs"\n',
            ),
          );
        }

        if (storage === StorageType.Arweave) {
          logger.warn(
            'WARNING: The "arweave" storage option will be going away soon. Please migrate to arweave-bundle or arweave-sol for mainnet.\n',
          );
        }

        if (storage === StorageType.ArweaveBundle && !arweaveJwk) {
          bail(
            new Error(
              'Path to Arweave JWK wallet file (--arweave-jwk) must be provided when using arweave-bundle',
            ),
          );
        }

        if (
          storage === StorageType.Ipfs &&
          (!ipfsInfuraProjectId || !ipfsInfuraSecret)
        ) {
          bail(
            new Error(
              'IPFS selected as storage option but Infura project id or secret key were not provided.',
            ),
          );
        }

        if (storage === StorageType.Aws && !awsS3Bucket) {
          throw new Error(
            'aws selected as storage option but existing bucket name (--aws-s3-bucket) not provided.',
          );
        }

        if (!Object.values(StorageType).includes(storage)) {
          bail(
            new Error(
              `Storage option must either be ${Object.values(StorageType).join(
                ', ',
              )}. Got: ${storage}`,
            ),
          );
        }

        const ipfsCredentials = {
          projectId: ipfsInfuraProjectId,
          secretKey: ipfsInfuraSecret,
        };

        let imageFileCount = 0;
        let animationFileCount = 0;
        let jsonFileCount = 0;

        // check if dir exists
        const dirExists = await fs
          .stat(`${dirname}/${processId}`)
          .then(() => true)
          .catch(() => false);
        const zipFilesDir = `${dirname}/${processId}/files`;
        const zipFile = `${dirname}/${processId}/files.zip`;

        if (!dirExists) {
          logger.info('Unzipping');
          await mkdirp(`${dirname}/${processId}`);
          await download(filesZipUrl, zipFile);
          await unzip(zipFile, zipFilesDir);
        } else {
          logger.info('Directory already exists');
        }

        let files = await fs.readdir(zipFilesDir);
        files = files.map((file) => path.join(zipFilesDir, file));

        const supportedImageTypes = {
          'image/png': 1,
          'image/gif': 1,
          'image/jpeg': 1,
        };
        const supportedAnimationTypes = {
          'video/mp4': 1,
          'video/quicktime': 1,
          'audio/mpeg': 1,
          'audio/x-flac': 1,
          'audio/wav': 1,
          'model/gltf-binary': 1,
          'text/html': 1,
        };

        const supportedFiles = files.filter((it) => {
          if (supportedImageTypes[getType(it)]) {
            imageFileCount++;
          } else if (supportedAnimationTypes[getType(it)]) {
            animationFileCount++;
          } else if (it.endsWith(EXTENSION_JSON)) {
            jsonFileCount++;
          } else {
            return false;
          }
          return true;
        });

        if (animationFileCount !== 0 && storage === StorageType.Arweave) {
          bail(
            new Error(
              'The "arweave" storage option is incompatible with animation files. Please try again with another storage option using `--storage <option>`.',
            ),
          );
        }

        if (animationFileCount !== 0 && animationFileCount !== jsonFileCount) {
          bail(
            new Error(
              `number of animation files (${animationFileCount}) is different than the number of json files (${jsonFileCount})`,
            ),
          );
        } else if (imageFileCount !== jsonFileCount) {
          bail(
            new Error(
              `number of img files (${imageFileCount}) is different than the number of json files (${jsonFileCount})`,
            ),
          );
        }

        const elemCount = number ? number : imageFileCount;
        if (elemCount < imageFileCount) {
          bail(
            new Error(
              `max number (${elemCount}) cannot be smaller than the number of images in the source folder (${imageFileCount})`,
            ),
          );
        }

        if (animationFileCount === 0) {
          logger.info(`Beginning the upload for ${elemCount} (img+json) pairs`);
        } else {
          logger.info(
            `Beginning the upload for ${elemCount} (img+animation+json) sets`,
          );
        }

        const collectionMintPubkey = await parseCollectionMintPubkey(
          collectionMint,
          anchorProgram.provider.connection,
          walletKeyPair,
        );

        logger.info('About to start uploadV2');
        await uploadV2(logger, {
          files: supportedFiles,
          cacheName: processId,
          env: env as 'mainnet-beta' | 'devnet',
          totalNFTs: elemCount,
          gatekeeper,
          storage,
          retainAuthority,
          mutable,
          nftStorageKey,
          nftStorageGateway,
          ipfsCredentials,
          pinataJwt,
          pinataGateway,
          awsS3Bucket,
          batchSize,
          price,
          treasuryWallet,
          anchorProgram,
          walletKeyPair,
          splToken,
          endSettings,
          hiddenSettings,
          whitelistMintSettings,
          goLiveDate,
          uuid,
          arweaveJwk,
          rateLimit: 5 /* prob 10 */,
          collectionMintPubkey,
          setCollectionMint,
          rpcUrl: rpc,
          callbackUrl: args.callbackUrl,
          guid: args.guid,
        });
        logger.info('Finished uploadV2');

        return { processId };
      } catch (err) {
        logger.error('Errored out', err);
        throw err;
      }
    },
    {
      retries: 3,
      onRetry(e, attempt) {
        logger.info('Retrying');
        logger.error(e?.message ?? 'UNKNOWN_ERR');
        logger.error(`Retrying... Attempt ${attempt}`);
      },
    },
  );
};

export const CandyMachineUploadResult = objectType({
  name: 'CandyMachineUploadResult',
  description: 'Result from calling candy machine upload',
  definition(t) {
    t.nonNull.string('processId', {
      description: 'Process id handle',
    });
  },
});

export const CandyMachineUploadMutation = mutationField('candyMachineUpload', {
  type: 'CandyMachineUploadResult',
  args: {
    keyPair: nonNull(
      stringArg({
        description: 'Wallet keypair',
      }),
    ),
    callbackUrl: nonNull(
      stringArg({
        description: 'Candy Machine Creation callback URL',
      }),
    ),
    config: nonNull(
      arg({
        type: 'JSON',
        description: 'Candy machine configuration',
      }),
    ),
    collectionMint: nonNull(
      stringArg({
        description: 'Collection mint pubkey',
      }),
    ),
    setCollectionMint: nonNull(
      booleanArg({
        description: 'Set collection mint pubkey',
      }),
    ),
    filesZipUrl: nonNull(
      stringArg({
        description: 'Zip file url with the assets',
      }),
    ),
    guid: stringArg({
      description: 'Campus GUID',
    }),
    rpc: nonNull(
      stringArg({
        description: 'RPC To use, can point to devnet | mainnet',
      }),
    ),
    env: nonNull(
      stringArg({
        description: 'Solana env, either mainnet-beta | devnet | testnet',
      }),
    ),
  },
  async resolve(_, args, _ctx: YogaInitialContext) {
    const processId = uuidv4();
    const logger = winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      defaultMeta: { processId },
      transports: [
        new winston.transports.File({
          filename: `${dirname}/logs/${processId}.txt`,
        }),
      ],
    });
    if (process.env.NODE_ENV !== 'production') {
      logger.add(
        new winston.transports.Console({
          format: winston.format.simple(),
        }),
      );
    }
    if (
      !(await fs
        .stat(CACHE_PATH)
        .then(() => true)
        .catch(() => false))
    ) {
      await fs.mkdir(CACHE_PATH);
    }

    runUploadV2(logger, processId, args)
      .catch((err) => {
        logger.error('Aborting due to error');
        logger.error(err);
      })
      .finally(async () => {
        logger.info('Cleaning up');
        await new Promise<void>((resolve, reject) => {
          rimraf(`${dirname}/${processId}`, (err) => {
            if (err) {
              reject(err);
            }
            resolve();
          });
        });
      });

    return { processId };
  },
});

export const CandyMachineUploadLogsResult = objectType({
  name: 'CandyMachineUploadLogsResult',
  description: 'Result from calling candy machine upload logs',
  definition(t) {
    t.nonNull.string('processId', {
      description: 'Process id handle',
    });
    t.nonNull.field('logs', {
      type: 'JSON',
    });
  },
});

export const CandyMachineUploadLogsQuery = queryField(
  'candyMachineUploadLogs',
  {
    type: 'CandyMachineUploadLogsResult',
    description: 'Get logs for a candy machine upload process',
    args: {
      processId: nonNull(
        stringArg({
          description: 'Process id handle',
        }),
      ),
    },
    async resolve(_, args, _ctx: YogaInitialContext) {
      const { processId } = args;
      if (!isUuid(processId)) {
        throw new Error('Invalid processId');
      }

      const logsPath = `${dirname}/logs/${processId}.txt`;
      const fileExists = await fs
        .stat(logsPath)
        .then(() => true)
        .catch(() => false);

      if (!fileExists) {
        return {
          processId,
          logs: [{ message: 'Process handle not found (log file not found)' }],
        };
      }
      // Read logs file
      const logFile = await fs.readFile(logsPath, 'utf8');
      const logs = logFile
        .split('\n')
        .map((l) => {
          try {
            const parsed = JSON.parse(l);
            return parsed;
          } catch (e) {
            return null;
          }
        })
        .filter((l) => l !== null);
      return { processId, logs: { entries: logs } };
    },
  },
);
