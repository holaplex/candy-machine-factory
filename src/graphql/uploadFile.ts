import { nonNull, mutationField, arg, objectType, scalarType } from 'nexus';
import { YogaInitialContext } from 'graphql-yoga';
import { NFTStorage } from 'nft.storage';
import { createReadStream, createWriteStream, unlink } from 'fs';
export const fromDwebLink = (cid: string): string =>
  `https://${cid}.ipfs.dweb.link`;

export const UploadFileResult = objectType({
  name: 'UploadFileResult',
  description: 'The result for uploading a file',
  definition (t) {
    t.nonNull.string('message', {
      description: 'Upload url of the file',
    });
  },
});

export const UploadScalar = scalarType({
  name: 'Upload',
  asNexusMethod: 'upload',
  description: 'The `Upload` scalar type represents a file upload.',
  sourceType: 'File',
});

export const UploadFile = mutationField('uploadFile', {
  type: 'UploadFileResult',
  args: { file: nonNull(arg({ type: 'Upload' })) },
  async resolve (_, { file }, ctx: YogaInitialContext) {
    const nftstorage = new NFTStorage({
      token: '', // TODO: get token from ????
    });
    let fileBlob,
      cid = '';

    try {
      fileBlob = await file.slice();
    } catch (err) {
      return {
        message: `Error: {err.message}`,
      };
    }

    try {
      cid = await nftstorage.storeBlob(fileBlob);
    } catch (err) {
      return {
        message: `Error: ${err.message}`,
      };
    }

    return {
      message: fromDwebLink(cid),
    };
  },
});
