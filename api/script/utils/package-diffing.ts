// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as diffErrorUtils from "./diff-error-handling";
import * as env from "../environment";
import * as fs from "fs";
import * as hashUtils from "../utils/hash-utils";
import * as path from "path";
import * as q from "q";
import * as security from "../utils/security";
import * as semver from "semver";
import * as storageTypes from "../storage/storage";
import * as stream from "stream";
import * as streamifier from "streamifier";
import * as superagent from "superagent";
import * as yazl from "yazl";
import * as yauzl from "yauzl";
import PackageManifest = hashUtils.PackageManifest;
import Promise = q.Promise;
import request = require("superagent");

interface IArchiveDiff {
  deletedFiles: string[];
  newOrUpdatedEntries: Map<string, string>; // K = name, V = hash
}

interface DiffBlobInfo {
  packageHash: string;
  blobInfo: storageTypes.BlobInfo;
}

export class PackageDiffer {
  private static MANIFEST_FILE_NAME: string = "hotcodepush.json";
  private static WORK_DIRECTORY_PATH: string = env.getTempDirectory();
  private static IS_WORK_DIRECTORY_CREATED: boolean = false;

  private _storage: storageTypes.Storage;
  private _maxPackagesToDiff: number;

  constructor(storage: storageTypes.Storage, maxPackagesToDiff?: number) {
    this._maxPackagesToDiff = maxPackagesToDiff || 1;
    this._storage = storage;
  }

  public generateDiffPackageMap(
    accountId: string,
    appId: string,
    deploymentId: string,
    newPackage: storageTypes.Package
  ): Promise<storageTypes.PackageHashToBlobInfoMap> {
    if (!newPackage || !newPackage.blobUrl || !newPackage.manifestBlobUrl) {
      return q.reject<storageTypes.PackageHashToBlobInfoMap>(
        diffErrorUtils.diffError(diffErrorUtils.ErrorCode.InvalidArguments, "Package information missing")
      );
    }

    const manifestPromise: Promise<PackageManifest> = this.getManifest(newPackage);
    const historyPromise: Promise<storageTypes.Package[]> = this._storage.getPackageHistory(accountId, appId, deploymentId);
    const newReleaseFilePromise: Promise<string> = this.downloadArchiveFromUrl(newPackage.blobUrl);
    let newFilePath: string;

    return q
      .all<any>([manifestPromise, historyPromise, newReleaseFilePromise])
      .spread((newManifest: PackageManifest, history: storageTypes.Package[], downloadedArchiveFile: string) => {
        newFilePath = downloadedArchiveFile;
        console.log(`[DIFF] New package ${newPackage.label} appVersion=${newPackage.appVersion}, history length=${history ? history.length : 0}, newManifest=${newManifest ? `entries=${newManifest.toMap().size}` : 'NULL'}`);
        const packagesToDiff: storageTypes.Package[] = this.getPackagesToDiff(
          history,
          newPackage.appVersion,
          newPackage.packageHash,
          newPackage.label
        );
        console.log(`[DIFF] Packages to diff against: ${packagesToDiff ? packagesToDiff.map(p => `${p.label}(appVer=${p.appVersion}, hash=${p.packageHash?.substring(0,8)}, manifest=${!!p.manifestBlobUrl})`).join(', ') : 'NONE'}`);
        const diffBlobInfoPromises: Promise<DiffBlobInfo>[] = [];
        if (packagesToDiff) {
          packagesToDiff.forEach((appPackage: storageTypes.Package) => {
            diffBlobInfoPromises.push(
              this.uploadAndGetDiffBlobInfo(accountId, appPackage, newPackage.packageHash, newManifest, newFilePath)
            );
          });
        }

        return q.all(diffBlobInfoPromises);
      })
      .then((diffBlobInfoList: DiffBlobInfo[]) => {
        // all done, delete the downloaded archive file.
        fs.unlinkSync(newFilePath);

        console.log(`[DIFF] diffBlobInfoList: ${JSON.stringify(diffBlobInfoList?.map(d => d ? { hash: d.packageHash?.substring(0,8), size: d.blobInfo?.size } : null))}`);

        if (diffBlobInfoList && diffBlobInfoList.length) {
          let diffPackageMap: storageTypes.PackageHashToBlobInfoMap = null;
          diffBlobInfoList.forEach((diffBlobInfo: DiffBlobInfo) => {
            if (diffBlobInfo && diffBlobInfo.blobInfo) {
              diffPackageMap = diffPackageMap || {};
              diffPackageMap[diffBlobInfo.packageHash] = diffBlobInfo.blobInfo;
            }
          });

          return diffPackageMap;
        } else {
          return q<storageTypes.PackageHashToBlobInfoMap>(null);
        }
      })
      .catch((err: any) => {
        console.error(`[DIFF] Error during diff generation:`, err);
        return diffErrorUtils.diffErrorHandler(err);
      });
  }

  public generateDiffArchive(oldManifest: PackageManifest, newManifest: PackageManifest, newArchiveFilePath: string): Promise<string> {
    return Promise<string>(
      (resolve: (value?: string | Promise<string>) => void, reject: (reason: any) => void, notify: (progress: any) => void): void => {
        if (!oldManifest || !newManifest) {
          console.log(`[DIFF] generateDiffArchive: NULL manifest — old=${!!oldManifest}, new=${!!newManifest}`);
          resolve(null);
          return;
        }

        const diff: IArchiveDiff = PackageDiffer.generateDiff(oldManifest.toMap(), newManifest.toMap());

        console.log(`[DIFF] generateDiffArchive: deletedFiles=${diff.deletedFiles.length}, newOrUpdated=${diff.newOrUpdatedEntries.size}`);

        if (diff.deletedFiles.length === 0 && diff.newOrUpdatedEntries.size === 0) {
          console.log(`[DIFF] generateDiffArchive: identical content, no diff needed`);
          resolve(null);
          return;
        }

        PackageDiffer.ensureWorkDirectoryExists();

        const diffFilePath = path.join(PackageDiffer.WORK_DIRECTORY_PATH, "diff_" + PackageDiffer.randomString(20) + ".zip");
        const writeStream: stream.Writable = fs.createWriteStream(diffFilePath);
        const diffFile = new yazl.ZipFile();

        diffFile.outputStream.pipe(writeStream).on("close", (): void => {
          resolve(diffFilePath);
        });

        const json: string = JSON.stringify({ deletedFiles: diff.deletedFiles });
        const readStream: stream.Readable = streamifier.createReadStream(json);
        diffFile.addReadStream(readStream, PackageDiffer.MANIFEST_FILE_NAME);

        if (diff.newOrUpdatedEntries.size > 0) {
          yauzl.open(newArchiveFilePath, (error?: any, zipFile?: yauzl.ZipFile): void => {
            if (error) {
              reject(error);
              return;
            }

            let pendingEntries = 0;
            let readStreamError = null;

            zipFile
              .on("error", (error: any): void => {
                reject(error);
              })
              .on("entry", (entry: yauzl.IEntry): void => {
                if (
                  !PackageDiffer.isEntryInMap(entry.fileName, /*hash*/ null, diff.newOrUpdatedEntries, /*requireContentMatch*/ false)
                ) {
                  return;
                } else if (/\/$/.test(entry.fileName)) {
                  // this is a directory
                  diffFile.addEmptyDirectory(entry.fileName);
                  return;
                }

                pendingEntries++;

                zipFile.openReadStream(entry, (error?: any, readStream?: stream.Readable): void => {
                  if (error) {
                    reject(error);
                    return;
                  }

                  readStream
                    .on("error", (error: any): void => {
                      readStreamError = error;
                      reject(error);
                    });

                  diffFile.addReadStream(readStream, entry.fileName);
                });
              })
              .on("end", (): void => {
                // All entries have been read from the source zip.
                // Now finalize the diff zip — the writeStream "close" handler will resolve.
                if (!readStreamError) {
                  diffFile.end();
                }
              });
          });
        } else {
          diffFile.end();
        }
      }
    );
  }

  private uploadDiffArchiveBlob(blobId: string, diffArchiveFilePath: string): Promise<storageTypes.BlobInfo> {
    return Promise<storageTypes.BlobInfo>(
      (
        resolve: (value?: storageTypes.BlobInfo | Promise<storageTypes.BlobInfo>) => void,
        reject: (reason: any) => void,
        notify: (progress: any) => void
      ): void => {
        fs.stat(diffArchiveFilePath, (err: NodeJS.ErrnoException, stats: fs.Stats): void => {
          if (err) {
            reject(err);
            return;
          }

          const readable: fs.ReadStream = fs.createReadStream(diffArchiveFilePath);

          this._storage
            .addBlob(blobId, readable, stats.size)
            .then((blobId: string): Promise<string> => {
              return this._storage.getBlobUrl(blobId);
            })
            .then((blobUrl: string): void => {
              fs.unlink(diffArchiveFilePath, (error) => {
                if (error) {
                  console.error("Error occurred while unlinking file:", error);
                }
              });

              const diffBlobInfo: storageTypes.BlobInfo = { size: stats.size, url: blobUrl };

              resolve(diffBlobInfo);
            })
            .catch((): void => {
              resolve(null);
            })
            .done();
        });
      }
    );
  }

  private uploadAndGetDiffBlobInfo(
    accountId: string,
    appPackage: storageTypes.Package,
    newPackageHash: string,
    newManifest: PackageManifest,
    newFilePath: string
  ): Promise<DiffBlobInfo> {
    if (!appPackage || appPackage.packageHash === newPackageHash) {
      // If the packageHash matches, no need to calculate diff, its the same package.
      console.log(`[DIFF] Skipping ${appPackage?.label}: same packageHash`);
      return q<DiffBlobInfo>(null);
    }

    console.log(`[DIFF] Generating diff for old package ${appPackage.label}, manifestBlobUrl=${appPackage.manifestBlobUrl ? 'YES' : 'NO'}`);
    return this.getManifest(appPackage)
      .then((existingManifest?: PackageManifest) => {
        console.log(`[DIFF] Old manifest for ${appPackage.label}: ${existingManifest ? `entries=${existingManifest.toMap().size}` : 'NULL'}`);
        return this.generateDiffArchive(existingManifest, newManifest, newFilePath);
      })
      .then((diffArchiveFilePath?: string): Promise<storageTypes.BlobInfo> => {
        console.log(`[DIFF] Diff archive for ${appPackage.label}: ${diffArchiveFilePath || 'NULL'}`);
        if (diffArchiveFilePath) {
          return this.uploadDiffArchiveBlob(security.generateSecureKey(accountId), diffArchiveFilePath);
        }

        return q(<storageTypes.BlobInfo>null);
      })
      .then((blobInfo: storageTypes.BlobInfo) => {
        console.log(`[DIFF] Blob info for ${appPackage.label}: ${blobInfo ? `size=${blobInfo.size}` : 'NULL'}`);
        if (blobInfo) {
          return { packageHash: appPackage.packageHash, blobInfo: blobInfo };
        } else {
          return q<DiffBlobInfo>(null);
        }
      });
  }

  private getManifest(appPackage: storageTypes.Package): Promise<PackageManifest> {
    return Promise<PackageManifest>(
      (resolve: (manifest: PackageManifest) => void, reject: (error: any) => void, notify: (progress: any) => void): void => {
        if (!appPackage || !appPackage.manifestBlobUrl) {
          resolve(null);
          return;
        }

        const req: superagent.Request<any> = superagent.get(appPackage.manifestBlobUrl);
        const writeStream = new stream.Writable();
        let json = "";

        writeStream._write = (data: string | Buffer, encoding: string, callback: Function): void => {
          json += (<Buffer>data).toString("utf8");
          callback();
        };

        req.pipe(writeStream).on("finish", () => {
          const manifest: PackageManifest = PackageManifest.deserialize(json);

          resolve(manifest);
        });
      }
    );
  }

  private downloadArchiveFromUrl(url: string): Promise<string> {
    return Promise<string>(
      (resolve: (value?: string | Promise<string>) => void, reject: (reason: any) => void, notify: (progress: any) => void): void => {
        PackageDiffer.ensureWorkDirectoryExists();

        const downloadedArchiveFilePath = path.join(
          PackageDiffer.WORK_DIRECTORY_PATH,
          "temp_" + PackageDiffer.randomString(20) + ".zip"
        );
        const writeStream: stream.Writable = fs.createWriteStream(downloadedArchiveFilePath);
        const req: request.Request<any> = request.get(url);

        req.pipe(writeStream).on("finish", () => {
          resolve(downloadedArchiveFilePath);
        });
      }
    );
  }

  private getPackagesToDiff(
    history: storageTypes.Package[],
    appVersion: string,
    newPackageHash: string,
    newPackageLabel: string
  ): storageTypes.Package[] {
    if (!history || !history.length) {
      return null;
    }

    // We assume that the new package has been released and already is in history.
    // Only pick the packages that are released before the new package to generate diffs.
    let foundNewPackageInHistory: boolean = false;
    const validPackages: storageTypes.Package[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (!foundNewPackageInHistory) {
        foundNewPackageInHistory = history[i].label === newPackageLabel;
        continue;
      }

      if (validPackages.length === this._maxPackagesToDiff) {
        break;
      }

      const isMatchingAppVersion: boolean = PackageDiffer.isMatchingAppVersion(appVersion, history[i].appVersion);
      if (isMatchingAppVersion && history[i].packageHash !== newPackageHash) {
        validPackages.push(history[i]);
      }
    }

    // maintain the order of release.
    return validPackages.reverse();
  }

  private static generateDiff(oldFileHashes: Map<string, string>, newFileHashes: Map<string, string>): IArchiveDiff {
    const diff: IArchiveDiff = { deletedFiles: [], newOrUpdatedEntries: new Map<string, string>() };

    newFileHashes.forEach((hash: string, name: string): void => {
      if (!PackageDiffer.isEntryInMap(name, hash, oldFileHashes, /*requireContentMatch*/ true)) {
        diff.newOrUpdatedEntries.set(name, hash);
      }
    });

    oldFileHashes.forEach((hash: string, name: string): void => {
      if (!PackageDiffer.isEntryInMap(name, hash, newFileHashes, /*requireContentMatch*/ false)) {
        diff.deletedFiles.push(name);
      }
    });

    return diff;
  }

  private static isMatchingAppVersion(baseAppVersion: string, newAppVersion: string): boolean {
    let isMatchingAppVersion: boolean = false;
    if (!semver.valid(baseAppVersion)) {
      // baseAppVersion is a semver range
      if (!semver.valid(newAppVersion)) {
        // newAppVersion is a semver range
        isMatchingAppVersion = semver.validRange(newAppVersion) === semver.validRange(baseAppVersion);
      } else {
        // newAppVersion is not a semver range
        isMatchingAppVersion = semver.satisfies(newAppVersion, baseAppVersion);
      }
    } else {
      // baseAppVersion is not a semver range
      isMatchingAppVersion = semver.satisfies(baseAppVersion, newAppVersion);
    }

    return isMatchingAppVersion;
  }

  private static ensureWorkDirectoryExists(): void {
    if (!PackageDiffer.IS_WORK_DIRECTORY_CREATED) {
      if (!fs.existsSync(PackageDiffer.WORK_DIRECTORY_PATH)) {
        fs.mkdirSync(PackageDiffer.WORK_DIRECTORY_PATH);
      }

      // Memoize this check to avoid unnecessary file system access.
      PackageDiffer.IS_WORK_DIRECTORY_CREATED = true;
    }
  }

  private static isEntryInMap(name: string, hash: string, map: Map<string, string>, requireContentMatch?: boolean): boolean {
    const hashInMap: string = map.get(name);
    return requireContentMatch ? hashInMap === hash : !!hashInMap;
  }

  private static randomString(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let str = "";
    for (let i = 0; i < length; i++) {
      str += chars[Math.floor(Math.random() * chars.length)];
    }

    return str;
  }
}
