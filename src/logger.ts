/**
 * Stores and rotates logs
 */

import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'

/**
 * Utility methods
 */
const stringify = (obj) => {
  return JSON.stringify(obj, Object.getOwnPropertyNames(obj))
}

export class Logger {
  baseDir: string

  constructor({
    logsSubdirectory
  }: {
    logsSubdirectory: string
  }) {
    this.baseDir = path.join(__dirname, '../logs/' + logsSubdirectory + '/')
  }

  // Appends a string to a file. Creates the file if it does not exist.
  async append(filename: string, string: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.open(this.baseDir + filename, 'a', (err, fd) => {
        if (err || !fd) {
          return reject('Could not open file for appending: ' + stringify(err))
        }
        fs.appendFile(fd, string + '\n', err => {
          if (err) {
            return reject('Could not append to file: ' + stringify(err))
          }
          fs.close(fd, err => {
            if (err) {
              return reject('Could not close file: ' + stringify(err))
            }
            return resolve()
          })
        })
      })
    })
  }

  // Compress a string into .gz.b64 text data.
  async compress(string: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      zlib.gzip(string, (err, buffer) => {
        if (err || !buffer) {
          return reject('Could not compress. Error: ' + stringify(err))
        }
        return resolve(buffer.toString('base64'))
      })
    })
  }

  async decompress(gz_b64: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const inputBuffer = Buffer.from(gz_b64, 'base64')
      zlib.unzip(inputBuffer, (err, outputBuffer) => {
        if (err || !outputBuffer) {
          return reject('Could not decompress. Error: ' + stringify(err))
        }
        return resolve(outputBuffer.toString())
      })
    })
  }
}
