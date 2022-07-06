import {
  nonNull,
  inputObjectType,
  mutationField,
  arg,
  objectType,
  extendInputType,
  scalarType,
} from 'nexus';
import { YogaInitialContext } from 'graphql-yoga';
import { decryptEncodedPayload } from '../lib/cryptography/utils.js';

import {
  Metaplex,
  keypairIdentity,
  UploadMetadataOutput,
  Nft,
  CreateNftOutput,
  CreateNftInput,
} from '@metaplex-foundation/js-next';
import { Connection, clusterApiUrl, Keypair, PublicKey } from '@solana/web3.js';

export const MintNftResult = objectType({
  name: 'MintNftResult',
  description: 'The result for minting a NFT',
  definition (t) {
    t.nonNull.string('message', {
      description: 'Mint hash of newly minted NFT',
    });
  },
});

export const FileScalar = scalarType({
  name: 'File',
  asNexusMethod: 'file',
  description: 'The `File` scalar type represents a file upload.',
  sourceType: 'File',
});

export const NftAttribute = extendInputType({
  type: 'NftAttribute',
  definition (t) {
    t.field('trait_type', {
      type: 'String',
      description: 'Name of the attribute',
    });
    t.field('value', {
      type: 'String',
      description: 'Value of the attribute',
    });
  },
});

export const NftFile = extendInputType({
  type: 'NftFile',
  definition (t) {
    t.field('uri', {
      type: 'String',
      description: 'URI of the file',
    });
    t.field('type', {
      type: 'String',
      description: 'Type of the file',
    });
    t.field('cdn', {
      type: 'Boolean',
      description: 'Whether the file is hosted on the CDN',
    });
  },
});

export const NftProperties = extendInputType({
  type: 'NftProperties',
  definition (t) {
    t.field('category', {
      type: 'String',
      description: 'Category of the NFT',
    });
    t.list.field('files', {
      type: 'NftFile',
      description: 'Files associated with the NFT',
    });
  },
});

export const NftMetadata = inputObjectType({
  name: 'NftMetadata',
  description: 'Metadata for a NFT',
  definition (t) {
    t.nonNull.string('name', {
      description: 'Name of the NFT',
    });
    t.nonNull.string('symbol', {
      description: 'Symbol of the NFT',
    });
    t.nonNull.string('description', {
      description: 'Description of the NFT',
    });
    t.nonNull.string('image', {
      description: 'Image of the NFT',
    });
    t.nonNull.string('animation_url', {
      description: 'Animation URL of the NFT',
    });
    t.nonNull.string('external_url', {
      description: 'External URL of the NFT',
    });
    t.list.field('attributes', {
      type: 'NftAttribute',
      description: 'Metadata for the NFT',
    });
    t.field('properties', {
      type: 'NftProperties',
      description: 'Properties of the NFT',
    });
  },
});

export const MintNft = mutationField('mintNft', {
  type: 'MintNftResult',
  args: {
    encryptedMessage: nonNull(
      arg({
        type: 'EncryptedMessage',
      }),
    ),
    nftMetadata: arg({
      type: 'NftMetadata',
    }),
    nftMetadataJSON: arg({
      type: 'File',
    }),
    mintToAddress: arg({
      type: 'String',
    })
  },
  async resolve (_, args, ctx: YogaInitialContext) {
    const connection = new Connection(clusterApiUrl('mainnet-beta'));
    let uri: UploadMetadataOutput = null!;
    let nft: {
      nft: Nft;
    } & CreateNftOutput = null!;
    let wallet: Keypair = null!;

    let mintToPubkey: PublicKey = null;
    try {
      if (args.mintToAddress) {
        mintToPubkey = new PublicKey(args.mintToAddress!)
      }
    } catch (e) {
      return {
        message: `Error parsing mint to Address: ${e.message}`,
      };
    }

    const keyPairBytes = JSON.parse(
      decryptEncodedPayload(args.encryptedMessage),
    ) as number[];

    // Get create wallet from the client secrets
    try {
      wallet = Keypair.fromSecretKey(Uint8Array.from(keyPairBytes));
    } catch (e) {
      return {
        message: `Error creating wallet from client secret: ${e.message}`,
      };
    }

    // Get a new metaplex object
    const metaplex = new Metaplex(connection).use(keypairIdentity(wallet));

    // Upload NFT Metadata, use metadata from api call, assume NFT Standard format
    try {
      if (args.nftMetadata) {
        uri = await metaplex.nfts().uploadMetadata(args.nftMetadata);
      } else if (args.nftMetadataJSON) {
        try {
          const metadata = await args.nftMetadataJSON.text();
          const metadataJSON = JSON.parse(metadata);
          uri = await metaplex.nfts().uploadMetadata(metadataJSON);
        } catch (e) {
          return {
            message: `Error uploading NFT metadata: ${e.message}`,
          };
        }
      } else {
        throw new Error('No NFT Metadata provided');
      }
    } catch (e) {
      return {
        message: `Error uploading metadata: ${e.message}`,
      };
    }

    let create_input_data: CreateNftInput = uri;

    if (mintToPubkey) {
      // if mintTo arg is provided, we want the NFT owner to be that address instead of being owned by the mint.
      create_input_data.owner = mintToPubkey
    }
    
    // Create New NFT with the metadata
    try {
      nft = await metaplex.nfts().create(create_input_data);
    } catch (e) {
      return {
        message: `Error creating NFT: ${e.message}`,
      };
    }

    // Return the NFT mint address
    return {
      message: nft.mint.publicKey.toBase58(),
    };
  },
});
