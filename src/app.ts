require('source-map-support').install()
process.on('unhandledRejection', console.log)

import {
  Network,
  // ValidationMessage,
  Logger
} from '.'

/**
 * Example App
 */

let unlData = ''

function onUnlData(data) {
  // {
  //   isDuringStartup,
  //   isNewValidator,
  //   isNewManifest,
  //   validatorName,
  //   validation_public_key_base58,
  //   signing_key,
  //   Sequence,
  //   isFromManifestsStream = false
  // }
  // console.log('onUnlData', JSON.stringify(data))
  unlData += JSON.stringify(data) + '\n'
}

let validationMessages = ''

// const fixMasterKeyAsRegularKey = 'C4483A1896170C66C098DEA5B0E024309C60DC960DE5F01CD7AF986AA3D9AD37'
const deletableAccounts = '30CD365592B8EE40489BA01AE2F7555CAC9C983145871DC82A42A31CF5BAE7D9'
let ballot = {}
let ballotTimer = null;
const ledgers = {}

function onValidationReceived(validationMessage: any) {

  validationMessage.ledger_index = parseInt(validationMessage.ledger_index, 10)

  // amendments
  // base_fee
  // reserve_base
  // reserve_inc

  if (validationMessage.isOnUNL === true) {
    if (ledgers[validationMessage.ledger_index]) {
      ledgers[validationMessage.ledger_index]++
    } else {
      ledgers[validationMessage.ledger_index] = 1
    }
    if (ledgers[validationMessage.ledger_index] >= 32) {
      console.log(`Ledger ${validationMessage.ledger_index} received ${ledgers[validationMessage.ledger_index]} validations [${(validationMessage.ledger_index + 1) % 256}]`)
    }
  }

  if (validationMessage.isOnUNL === true && (validationMessage.ledger_index + 1) % 256 === 0) {
    if (!validationMessage.amendments) {
      console.log({
        'NO AMENDMENTS': 'No amendments in this message',
        validatorName: validationMessage.validatorName,
        master_key: validationMessage.master_key,
        validation_public_key: validationMessage.validation_public_key,
        timestamp: validationMessage.timestamp.format(),
        isOnUNL: validationMessage.isOnUNL,
        ledger_index: validationMessage.ledger_index,
        amendments: validationMessage.amendments
      }, ',')
    }

    if (validationMessage.isOnUNL) {
      if (validationMessage.amendments && validationMessage.amendments.includes(deletableAccounts)) {
        ballot[validationMessage.validatorName] = true
      } else {
        ballot[validationMessage.validatorName] = false
      }

      // 10 seconds after last validation received
      clearTimeout(ballotTimer);
      ballotTimer = setTimeout(() => {
        console.log(`==== DeletableAccounts: Current Votes @ Ledger ${validationMessage.ledger_index} ====`);
        const yeas = []
        const nays = []
        for (const [key, value] of Object.entries(ballot)) {
          if (value === true) {
            yeas.push(key)
          } else {
            nays.push(key)
          }
        }
        yeas.forEach(v => {
          console.log(`${v} - Yea`)
        })
        console.log(`Yeas: ${yeas.length}`)
        console.log(`--------`)
        nays.forEach(v => {
          console.log(`${v} - Nay`)
        })
        console.log(`Nays: ${nays.length}`)
        console.log(`--------`)
        console.log(`${yeas.length} / ${yeas.length + nays.length} = ${Math.floor((yeas.length / (yeas.length + nays.length)) * 100)}%`)
        ballot = {}
        ballotTimer = null;
      }, 10000)
    }
  }

  if (validationMessage.base_fee) {
    console.log({
      validatorName: validationMessage.validatorName,
      master_key: validationMessage.master_key,
      validation_public_key: validationMessage.validation_public_key,
      timestamp: validationMessage.timestamp.format(),
      isOnUNL: validationMessage.isOnUNL,
      ledger_index: validationMessage.ledger_index,
      base_fee: validationMessage.base_fee,
      reserve_base: validationMessage.reserve_base,
      reserve_inc: validationMessage.reserve_inc,
    }, ',')
  }

  if (use_example_logger) {
    validationMessages += JSON.stringify(validationMessage) + '\n'
  }
}

const network = new Network({
  network: 'MAINNET',
  // onUnlData,
  // onValidationReceived,
  verbose: true
})
network.onUnlData = onUnlData
network.onValidationReceived = onValidationReceived
network.connect()

// always false - disabled for now
const use_example_logger = false
if (use_example_logger) {
  const logger = new Logger({logsSubdirectory: 'MAINNET'})

  setInterval(async () => {
    await logger.append('unl-data.log', unlData)
    unlData = ''
    const compressedData = await logger.compress(validationMessages)
    const filename = 'validations-' + Date.now() + '.gz.b64'
    await logger.append(filename, compressedData)
    validationMessages = ''
    console.log(`Successfully wrote "unl-data.log" and "${filename}"`)
  }, 1000 * 60 * 10 /* every ten minutes */)

  console.log('Started example logger')
}
