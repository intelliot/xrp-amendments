import * as WebSocket from 'ws'
import * as moment from 'moment'
import * as request from 'request-promise-native'
import * as addressCodec from 'ripple-address-codec'
import * as codec from 'ripple-binary-codec'

// Load pre-cached names
const names = require('../validator-names.json')

// The validations stream sends messages whenever it receives validation messages,
// also called validation votes, from validators it trusts.
export interface ValidationMessage {

  // The value `validationReceived` indicates this is from the validations stream.
  type: 'validationReceived'

  // (May be omitted) The amendments this server wants to be added to the protocol.
  amendments?: string[]

  // (May be omitted) The unscaled transaction cost (`reference_fee` value) this
  // server wants to set by Fee Voting.
  base_fee?: number // Integer

  // Bit-mask of flags added to this validation message.
  // The flag 0x80000000 indicates that the validation signature is fully-canonical.
  // The flag 0x00000001 indicates that this is a full validation; otherwise it's a partial validation.
  // Partial validations are not meant to vote for any particular ledger.
  // A partial validation indicates that the validator is still online but not keeping up with consensus.
  flags: number

  // If true, this is a full validation. Otherwise, this is a partial validation.
  // Partial validations are not meant to vote for any particular ledger.
  // A partial validation indicates that the validator is still online but not keeping up with consensus.
  full: boolean

  // The identifying hash of the proposed ledger is being validated.
  ledger_hash: string

  // The Ledger Index of the proposed ledger.
  ledger_index: string // Integer

  // (May be omitted) The local load-scaled transaction cost this validator is
  // currently enforcing, in fee units.
  load_fee: number // Integer

  // (May be omitted) The minimum reserve requirement (`account_reserve` value)
  // this validator wants to set by Fee Voting.
  reserve_base: number // Integer

  // (May be omitted) The increment in the reserve requirement (`owner_reserve` value) this validator wants to set by Fee Voting.
  reserve_inc: number // Integer

  // The signature that the validator used to sign its vote for this ledger.
  signature: string

  // When this validation vote was signed, in seconds since the Ripple Epoch.
  signing_time: number
  
  // The base58 encoded public key from the key-pair that the validator used to sign the message.
  // This identifies the validator sending the message and can also be used to verify the signature.
  // Typically this is a signing key (signing_key). Use manifests to map this to an actual validation_public_key.
  validation_public_key: string

  // The time when the validation message was received; added by validation-tracker.
  timestamp?: moment.Moment

  // From manifestKeys; typically the public key of the master key pair; added by validation-tracker.
  master_key?: string
}

// Associates a signing_key with a master_key (pubkey).
export interface ManifestMessage {

  // The value `manifestReceived` indicates this is from the manifests stream.
  type: 'manifestReceived'

  // The base58 encoded NodePublic master key.
  master_key: string

  // The base58 encoded NodePublic signing key.
  signing_key: string

  // The sequence number of the manifest.
  seq: number // UInt

  // The signature, in hex, of the manifest.
  signature: string

  // The master signature, in hex, of the manifest.
  master_signature: string
}

// The manifest for a validator in a validator list.
export interface Manifest {
  // The hex encoded signing key (analogous to `signing_key` but in hex)
  SigningPubKey: string

  // The sequence number of the manifest (analogous to `seq`)
  Sequence: number
}

interface ValidationStreamOptions {
  address: string,
  onValidationReceived: (validationMessage: ValidationMessage) => void,
  onManifestReceived: (manifestMessage: ManifestMessage) => void,
  onClose: (cause: Error|{code: number, reason: string}) => void,
  useHeartbeat?: boolean,
  serverPingInterval?: number,
  latency?: number
}

class ValidationStream {
  readonly ws: WebSocket
  pingTimeout: NodeJS.Timer
  pingInterval: NodeJS.Timer
  requestSuccessIds: Array<number> = []

  constructor({
    address,
    onValidationReceived,
    onManifestReceived,
    onClose,
    useHeartbeat = false,
    serverPingInterval = 30000,
    latency = 1000
  } : ValidationStreamOptions) {
    this.ws = new WebSocket(address)

    if (useHeartbeat) {
      // Send 'ping' every `serverPingInterval` milliseconds
      this.pingInterval = setInterval(() => {
        this.ws.ping(() => {})
      }, serverPingInterval)

      const heartbeat = () => {
        clearTimeout(this.pingTimeout)

        // Use `WebSocket#terminate()` and not `WebSocket#close()`. Delay should be
        // equal to the interval at which your server sends out pings plus a
        // conservative assumption of the latency.
        this.pingTimeout = setTimeout(() => {
          console.error(`[${address}] WARNING: No heartbeat in ${serverPingInterval + latency} ms. Terminating...`)
          this.ws.terminate()
          // will be duplicated by code 1006 and reason ''
          onClose(new Error('Terminated due to lack of heartbeat'))
        }, serverPingInterval + latency)
      }
      
      this.ws.on('open', heartbeat)
      this.ws.on('ping', heartbeat)
      this.ws.on('close', (_code: number, _reason: string) => {
        clearTimeout(this.pingInterval)
        clearTimeout(this.pingTimeout)
        // no need here, it's already called:
        //onClose({code, reason})
      })
    }

    // You always get a 'close' event after an 'error' event.
    this.ws.on('error', (error: Error) => {
      console.error(`[${address}] ERROR: ${error}`)
    })
  
    // If the connection was closed abnormally (with an error), or if the close
    // control frame was malformed or not received then the close code must be
    // 1006.
    this.ws.on('close', (code: number, reason: string) => {
      onClose({code, reason})
    })
  
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        id: 1,
        command: 'subscribe',
        streams: ['validations']
      }), () => {
        // Subscribe to 'manifests' stream
        //
        // Disabled due to revocation manifest bug
        //
        // this.ws.send(JSON.stringify({
        //   id: 2,
        //   command: 'subscribe',
        //   streams: ['manifests']
        // }))

        console.info('Subscribed to `validations`.')
      })
    })

    this.ws.on('message', (data: string|Buffer|ArrayBuffer|Buffer[]) => {
      const dataObj = JSON.parse(data as string)

      if (dataObj.type === 'validationReceived') {
        const validationMessage: ValidationMessage = dataObj
        onValidationReceived(validationMessage)
      } else if (dataObj.type === 'manifestReceived') {
        const manifestMessage: ManifestMessage = dataObj
        onManifestReceived(manifestMessage)
      } else if (dataObj.type === 'response' && dataObj.status === 'success') {
        // All is well...

        // Successfully subscribed to 'validations':
        // {"id":1,"result":{},"status":"success","type":"response"}

        // Successfully subscribed to 'manifests':
        // {"id":2,"result":{},"status":"success","type":"response"}

        this.requestSuccessIds.push(dataObj.id)
        if (this.requestSuccessIds.length === 2) {
          console.info(`[${address}] Successfully connected and subscribed`)
        }
      } else if (dataObj.error === 'unknownStream') {
        // One or more the members of the `streams` field of the request is not a valid stream name.

        console.error(`[${address}] WARNING: 'unknownStream' message received. Terminating...`)
        this.ws.terminate()
        onClose(new Error('Terminated due "unknownStream" message'))
      } else {
        console.error(`[${address}] WARNING: Unexpected message: ${data}`)
      }
    })
  }

  readyState() {
    switch(this.ws.readyState) {
      case 0: {
        return {
          state: 'CONNECTING',
          value: this.ws.readyState,
          description: 'The connection is not yet open.'
        }
      }
      case 1: {
        return {
          state: 'OPEN',
          value: this.ws.readyState,
          description: 'The connection is open and ready to communicate.'
        }
      }
      case 2: {
        return {
          state: 'CLOSING',
          value: this.ws.readyState,
          description: 'The connection is in the process of closing.'
        }
      }
      case 3: {
        return {
          state: 'CLOSED',
          value: this.ws.readyState,
          description: 'The connection is closed.'
        }
      }
      default: {
        return {
          state: 'UNKNOWN',
          value: this.ws.readyState,
          description: 'The connection is in an unrecognized state.'
        }
      }
    }
  }
}

/**
 * Utility methods
 */

function toBytes(hex) {
  return Buffer.from(hex, 'hex').toJSON().data
}

function hexToBase58(hex) {
  return addressCodec.encodeNodePublic(toBytes(hex))
}

function remove(array, element) {
  const index = array.indexOf(element)
  if (index !== -1) {
    array.splice(index, 1)
  }
}

export type UnlData = {
  isDuringStartup: boolean
  isNewValidator: boolean
  isNewManifest: boolean
  validatorName: string
  validation_public_key_base58: string
  signing_key: string
  Sequence: number
  isFromManifestsStream?: boolean
}
export type NetworkType = 'ALTNET'|'MAINNET'
export type OnUnlDataCallback = (data: UnlData) => void

export class Network {
  network: NetworkType

  static readonly WS_PORT = '51233'

  delete_from_dedup_after_seconds: number = 30
  dedup_validations_set: Set<string> = new Set()
  dedup_last_signing_time: number = 0

  dedup_clear() {
    this.dedup_validations_set.forEach((value: string) => {
      // `value` is more than 30 seconds old, based on signing_time
      const validationMessage: ValidationMessage = JSON.parse(value)
      if (validationMessage.signing_time + this.delete_from_dedup_after_seconds < this.dedup_last_signing_time) {
        this.dedup_validations_set.delete(value)
      }
    })
  }

  validationStreams: {
    // key: The address of the validator ('ws://' + ip + ':' + WS_PORT).
    [key: string]: ValidationStream
  } = {}

  lastValidatorListSequence: number = 0

  validators: {
    // key: The public key of the validator, in base58 (validation_public_key_base58).
    [key: string]: {
      // The base58 encoded NodePublic signing key.
      // Also known as the SigningPubKey (hex), but in base58.
      signing_key: string

      // The sequence number of the latest manifest that informed us about this validator.
      Sequence: number // UInt
    }
  } = {}
  
  names: {
    // key: The public key of the validator, in base58 (validation_public_key_base58).
    // value: The name (typically the domain name) of the validator.
    [key: string]: string
  } = {}

  // Mapping of validator signing keys to pubkeys (validation_public_key_base58).
  // Used to get the actual `validation_public_key` from the `validation_public_key` (signing key) in the ValidationMessage.
  manifestKeys: {
    // key: The signing_key of the validator (SigningPubKey but in base58).
    // value: The public key of the validator, in base58 (validation_public_key_base58).
    [key: string]: string
  } = {}

  onUnlData: OnUnlDataCallback
  onValidationReceived: (validationMessage: ValidationMessage) => void
  verbose: boolean
  require_master_key: boolean // if `true`, exclude validators that do not use manifests

  constructor(options: {
    network: NetworkType
    require_master_key?: boolean
    // onUnlData: OnUnlDataCallback
    // onValidationReceived: (validationMessage: ValidationMessage) => void,
    verbose?: boolean
  }) {
    this.network = options.network
    this.require_master_key = options.require_master_key === undefined ? false : options.require_master_key // default false
    this.onUnlData = () => {}
    this.onValidationReceived = () => {}
    this.verbose = options.verbose === undefined ? true : options.verbose // default true
    this.names = names
  }

  async refreshSubscriptions() {
    if (this.verbose) {
      console.info(`[${this.network}] Refreshing subscriptions...`)
    }
    await this.getUNL()
    await this.subscribeToRippleds()
  }
  
  connect() {
    // refresh connections
    // every minute
    // setInterval(this.refreshSubscriptions.bind(this), 60 * 1000)
    this.refreshSubscriptions()

    // Remove old entries from the Set every 30 seconds
    setInterval(this.dedup_clear.bind(this), this.delete_from_dedup_after_seconds * 1000)
  }

  async subscribeToRippleds() {
    console.info('Subscribing to rippleds...')

    const onManifestReceived = async ({
      master_key,
      seq,
      signing_key
    }: ManifestMessage) => {
      // master_key === validation_public_key_base58
      if (this.validators[master_key] && this.validators[master_key].Sequence < seq) {
        // Delete old signing_key from manifestKeys
        delete this.manifestKeys[this.validators[master_key].signing_key]

        // Set new signing_key
        this.validators[master_key].signing_key = signing_key

        // Set new Sequence
        this.validators[master_key].Sequence = seq
        
        // Add new signing_key to manifestKeys
        this.manifestKeys[signing_key] = master_key

        // Call onUnlData callback with new data
        this.onUnlData({
          isDuringStartup: false,
          isNewValidator: false,
          isNewManifest: true,
          validatorName: await this.fetchName(master_key),
          validation_public_key_base58: master_key,
          signing_key,
          Sequence: seq,
          isFromManifestsStream: true
        })
      }
    }

    const onCloseAddress = (address: string, cause: Error|{code: number, reason: string}) => {
      if (this.validationStreams[address]) {
        if (this.validationStreams[address].readyState().state === 'OPEN') {
          console.error(`[${this.network}] [${address}] onClose: UNEXPECTED readyState(): 'OPEN'`)
        } else {
          console.info(`[${this.network}] [${address}] onClose: readyState(): '${this.validationStreams[address].readyState().state}'`)
        }
        console.error(`[${this.network}] [${address}] onClose: Error/reason: ${JSON.stringify(cause, Object.getOwnPropertyNames(cause))}. Deleting...`)
        delete this.validationStreams[address]
      } else {
        console.info(`[${this.network}] [${address}] onClose: Error/reason: ${JSON.stringify(cause, Object.getOwnPropertyNames(cause))}. Already deleted!`)
      }
    }

    // TODO: altnet support
    // const hostname = this.network === 'ALTNET' ? ...

    const address = 'ws://s1.ripple.com:' + Network.WS_PORT
    if (!this.validationStreams[address]) {
      this.validationStreams[address] = new ValidationStream({
        address,
        onValidationReceived: async (validationMessage: ValidationMessage) => {
          if (this.require_master_key &&
              !this.manifestKeys[validationMessage.validation_public_key]) {
            return
          }
          if (!this.dedup_validations_set.has(JSON.stringify(validationMessage))) {
            this.dedup_validations_set.add(JSON.stringify(validationMessage))
            const master_key = this.manifestKeys[validationMessage.validation_public_key]

            // const validatorName = await this.fetchName(master_key || validationMessage.validation_public_key)
            const validatorName = this.names[master_key || validationMessage.validation_public_key]

            this.onValidationReceived(Object.assign({}, validationMessage, {
              validatorName,
              master_key,
              timestamp: moment(),
              isOnUNL: this.validators[master_key] ? true : false
            }))
          }
          if (this.dedup_last_signing_time < validationMessage.signing_time) {
            this.dedup_last_signing_time = validationMessage.signing_time
          }
        },
        onManifestReceived,
        onClose: (cause: Error|{code: number, reason: string}) => { onCloseAddress(address, cause) }
      })
    }
  }

  attempted = []
  async fetchName(validation_public_key_base58: string): Promise<string> {
    if (this.attempted.includes(validation_public_key_base58)) {
      return validation_public_key_base58;
    }
    this.attempted.push(validation_public_key_base58);

    if (!this.names[validation_public_key_base58]) {
      console.info(`[${this.network}] Attempting to retrieve name of ${validation_public_key_base58} from the Data API...`)
      return request.get({
        url: 'https://data.ripple.com/v2/network/validators/' + validation_public_key_base58,
        json: true
      }).then(data => {
        if (data.domain) {
          console.info(`[${this.network}] Retrieved name: ${data.domain} (${validation_public_key_base58})`)
          this.names[validation_public_key_base58] = data.domain
          return this.names[validation_public_key_base58]
        } else {
          console.warn(`[${this.network}] [${validation_public_key_base58}] No name available. Data: ${JSON.stringify(data)}`)
        }
        return validation_public_key_base58
      }).catch(() => {
        console.warn(`[${this.network}] [${validation_public_key_base58}] Request failed`)
        return validation_public_key_base58
      })
    }
    return this.names[validation_public_key_base58]
  }

  async getUNL() {
    const validatorListUrl = this.network === 'ALTNET' ? 'https://vl.altnet.rippletest.net' : 'https://vl.ripple.com'

    return new Promise<void>((resolve, reject) => {
      request.get({
        url: validatorListUrl,
        json: true
      }).then(async (data) => {
        const buffer = Buffer.from(data.blob, 'base64')
        const validatorList = JSON.parse(buffer.toString('ascii'))
        if (validatorList.sequence <= this.lastValidatorListSequence) {
          // Nothing new here...
          return resolve()
        }
        this.lastValidatorListSequence = validatorList.sequence
        const validatorsToDelete = Object.keys(this.validators)
        const isDuringStartup = (validatorsToDelete.length === 0)
        for (const validator of validatorList.validators) {
          const validation_public_key_base58 = hexToBase58(validator.validation_public_key)
          remove(validatorsToDelete, validation_public_key_base58)

          const manifestBuffer = Buffer.from(validator.manifest, 'base64')
          const manifestHex = manifestBuffer.toString('hex').toUpperCase()
          const manifest = codec.decode(manifestHex)
          if (!this.validators[validation_public_key_base58] ||
              this.validators[validation_public_key_base58].Sequence < manifest.Sequence) {
            let isNewValidator = false
            let isNewManifest = false
            const signing_key = hexToBase58(manifest.SigningPubKey)
            const Sequence = manifest.Sequence
            if (this.validators[validation_public_key_base58]) {
              this.validators[validation_public_key_base58].signing_key = signing_key
              this.validators[validation_public_key_base58].Sequence = Sequence
              isNewManifest = true
            } else {
              this.validators[validation_public_key_base58] = {
                signing_key,
                Sequence
              }
              isNewValidator = true
              isNewManifest = true // always
            }

            const validatorName = await this.fetchName(validation_public_key_base58)
            this.onUnlData({
              isDuringStartup,
              isNewValidator,
              isNewManifest,
              validatorName,
              validation_public_key_base58,
              signing_key,
              Sequence
            })
            this.manifestKeys[signing_key] = validation_public_key_base58
          }
        } // for (const validator of validatorList.validators)
        for (const validator of validatorsToDelete) {
          delete this.validators[validator]
        }
        if (this.verbose) {
          console.info(`[${this.network}] getUNL: Now have ${Object.keys(this.validators).length} validators and ${Object.keys(this.manifestKeys).length} manifestKeys`)
        }
        return resolve()
      }).catch(err => {
        return reject(err)
      })
    })
  }
}
