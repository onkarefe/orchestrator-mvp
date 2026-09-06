import path from 'node:path';

import {
  normalizeFtpProtocol,
  normalizeFtpRemoteDir,
  normalizeFtpTempSuffix,
} from '../config/ftpUpload.js';

export class FactoryFtpError extends Error {
  constructor(code, message = code, { retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FactoryFtpError';
    this.code = code;
    this.retryable = retryable;
  }
}

function assertRemoteFileName(value) {
  const fileName = String(value ?? '').trim();

  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('\0') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    path.posix.basename(fileName) !== fileName ||
    path.win32.basename(fileName) !== fileName
  ) {
    throw new FactoryFtpError(
      'invalid_remote_file_name',
      'Remote filename must be a basename'
    );
  }

  return fileName;
}

export class FactoryFtpClient {
  constructor({ config, clientFactory } = {}) {
    this.config = config;
    this.clientFactory = clientFactory;
    this.client = null;
    this.remoteDir = normalizeFtpRemoteDir(config?.FTP_REMOTE_DIR);
    this.tempSuffix = normalizeFtpTempSuffix(config?.FTP_TEMP_SUFFIX);
  }

  async connect() {
    const protocol = normalizeFtpProtocol(this.config?.FTP_PROTOCOL);

    if (!['ftp', 'ftps'].includes(protocol)) {
      throw new FactoryFtpError(
        'unsupported_protocol',
        'Factory upload protocol is unsupported'
      );
    }

    if (!this.remoteDir || !this.tempSuffix) {
      throw new FactoryFtpError(
        'invalid_ftp_configuration',
        'Factory FTP directory or temporary suffix is invalid'
      );
    }

    try {
      if (this.clientFactory) {
        this.client = await this.clientFactory({
          connectTimeoutMs: this.config.FTP_UPLOAD_CONNECT_TIMEOUT_MS,
        });
      } else {
        const { Client } = await import('basic-ftp');
        this.client = new Client(
          Number(this.config.FTP_UPLOAD_CONNECT_TIMEOUT_MS) || 30000
        );
      }

      if (this.client?.ftp) {
        this.client.ftp.verbose = false;
      }

      await this.client.access({
        host: this.config.FTP_HOST,
        port: Number(this.config.FTP_PORT) || 21,
        user: this.config.FTP_USERNAME,
        password: this.config.FTP_PASSWORD,
        secure: Boolean(this.config.FTP_SECURE || protocol === 'ftps'),
      });

      if (this.client?.ftp) {
        this.client.ftp.timeout =
          Number(this.config.FTP_UPLOAD_TRANSFER_TIMEOUT_MS) || 120000;
      }

      await this.client.cd(this.remoteDir);
      return this;
    } catch (error) {
      this.close();

      if (error instanceof FactoryFtpError) {
        throw error;
      }

      throw new FactoryFtpError(
        'ftp_connection_failed',
        'Factory FTP connection failed',
        { retryable: true, cause: error }
      );
    }
  }

  async fileExists(remoteFileName) {
    const fileName = assertRemoteFileName(remoteFileName);

    try {
      const entries = await this.client.list();

      return entries.some((entry) => entry?.name === fileName);
    } catch (error) {
      throw new FactoryFtpError(
        'ftp_remote_list_failed',
        'Could not inspect factory FTP directory',
        { retryable: true, cause: error }
      );
    }
  }

  async uploadTemporary(localPath, finalFileName) {
    const fileName = assertRemoteFileName(finalFileName);
    const temporaryFileName = assertRemoteFileName(
      `${fileName}${this.tempSuffix}`
    );

    if (await this.fileExists(fileName)) {
      throw new FactoryFtpError(
        'remote_file_exists',
        `Factory FTP file already exists: ${fileName}`
      );
    }

    try {
      if (await this.fileExists(temporaryFileName)) {
        await this.client.remove(temporaryFileName);
      }

      await this.client.uploadFrom(localPath, temporaryFileName);

      return {
        temporaryFileName,
        finalFileName: fileName,
      };
    } catch (error) {
      if (error instanceof FactoryFtpError) {
        throw error;
      }

      throw new FactoryFtpError(
        'ftp_temporary_upload_failed',
        `Factory FTP temporary upload failed: ${temporaryFileName}`,
        { retryable: true, cause: error }
      );
    }
  }

  async downloadFile(remoteFileName, localPath) {
    const fileName = assertRemoteFileName(remoteFileName);

    try {
      await this.client.downloadTo(localPath, fileName);
    } catch (error) {
      throw new FactoryFtpError(
        'ftp_remote_download_failed',
        `Factory FTP file could not be read for identity verification: ${fileName}`,
        { retryable: true, cause: error }
      );
    }
  }

  async renameTemporary(temporaryFileName, finalFileName) {
    const temporaryName = assertRemoteFileName(temporaryFileName);
    const finalName = assertRemoteFileName(finalFileName);

    if (await this.fileExists(finalName)) {
      throw new FactoryFtpError(
        'remote_file_exists',
        `Factory FTP file already exists: ${finalName}`
      );
    }

    try {
      await this.client.rename(temporaryName, finalName);
    } catch (error) {
      throw new FactoryFtpError(
        'ftp_final_rename_failed',
        `Factory FTP final rename failed: ${finalName}`,
        { retryable: true, cause: error }
      );
    }
  }

  remotePath(fileName) {
    return path.posix.join(this.remoteDir, assertRemoteFileName(fileName));
  }

  close() {
    if (this.client) {
      const client = this.client;
      this.client = null;

      try {
        client.close();
      } catch {
        // Closing is best-effort and must not mask the durable task result.
      }
    }
  }
}

export default FactoryFtpClient;
