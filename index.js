require('dotenv').config({ path: './.env' })
const { exec } = require('node:child_process')
const os = require('os')
const fs = require('fs').promises
const ffmpeg = require('fluent-ffmpeg')
const temp = require('temp').track()
const Queue = require('bull')

const numOfCpus = parseInt(process.env.MAX_PROCESS) || os.cpus().length

console.log('start with', numOfCpus, 'workers')

async function asyncExecFile (app, args) {
  return new Promise((resolve, reject) => {
    exec(`${app} ${args.join(' ')}`, (err, stdout, stderr) => {
      if (err) {
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

const redisConfig =  {
  port: process.env.REDIS_PORT,
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASSWORD
}

const removebgQueue = new Queue('removebg', {
  redis: redisConfig
})

if (os.platform() === 'darwin') {
  async function removebg (tempInput) {
    console.time('🖼️  removebg')
    const output = await asyncExecFile('shortcuts',
      [
        'run removebg ',
        '-i', tempInput,
        ' | cat'
      ]
    ).catch((err) => {
      console.log(err)
    })
    console.timeEnd('🖼️  removebg')

    return output
  }

  removebgQueue.process(numOfCpus, async (job, done) => {
    const { fileUrl } = job.data

    const tempInput = temp.path({ suffix: '.jpg' })

    // download file to temp
    await asyncExecFile('curl', ['-s', fileUrl, '-o', tempInput]).catch((err) => {
      console.error(err)
      done(err)
    })

    const output = await removebg(tempInput).catch((err) => {
      console.error(err)
      done(err)
    })

    await fs.unlink(tempInput).catch((() => {}))

    const file = output.stdout

    const content = await fs.readFile(file, { encoding: 'base64' }).catch((err) => {
      console.error(err)
      done(err)
    });

    await fs.unlink(file).catch((() => {}))

    if (content) {
      done(null, {
        content
      })
    } else {
      done(new Error('removebg failed'))
    }
  })
}


const convertQueue = new Queue('convert', {
  redis: redisConfig
})

setInterval(() => {
  convertQueue.clean(1000 * 60)
}, 1000 * 5)

convertQueue.process(numOfCpus, async (job, done) => {
  // if timestamp > 10 minutes ago, skip
  if (job.timestamp < Date.now() - 1000 * 60 * 10) {
    return done(new Error('job is too old'))
  }

  const output = temp.path({ suffix: '.webm' })

  const consoleName = `📹 job convert #${job.id}`

  console.time(consoleName)
  bitrate = (job.data.bitrate) || process.env.DEFAULT_BITRATE || 400
  isEmoji = (job.data.isEmoji) || false

  let input
  if (job.data.fileData) {
    input = `data:video/mp4;base64,${job.data.fileData}`
  } else {
    input = job.data.fileUrl
  }

  const file = await convertToWebmSticker(input, job.data.type, job.data.forceCrop, job.data.isEmoji, output, bitrate).catch((err) => {
    err.message = `${os.hostname} ::: ${err.message}`
    done(err)
  })

  if (file) {
    const content = await fs.readFile(file.output, { encoding: 'base64' }).catch((err) => {
      console.error(err)
      done(err)
    });

    done(null, {
      metadata: file.metadata,
      content
    })
  }

  await fs.unlink(output).catch(() => {})

  console.timeEnd(consoleName)
})

const ffprobePromise = (file) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) {
        reject(err)
      } else {
        resolve(metadata)
      }
    })
  })
}

async function convertToWebmSticker(input, type, forceCrop, isEmoji, output, bitrate) {
  let inputOptions = ['-t 3']
  outputDimensions = { w: 512, h: 512 }
  if (isEmoji) outputDimensions = { w: 100, h: 100 }
  const scaleFilter = {
    filter: "scale",
    options: { w: outputDimensions.w, h: outputDimensions.h, force_original_aspect_ratio: "decrease" },
    inputs: "[sticker]",
    outputs: "[sticker]"
  }
  const cropFilter = [{
    filter: "scale",
    options: { w: outputDimensions.w, h: outputDimensions.h, force_original_aspect_ratio: "increase" },
    inputs: "[sticker]",
    outputs: "[sticker]"
  },
  {
    filter: "crop",
    options: { w: outputDimensions.w, h: outputDimensions.h, },
    inputs: "[sticker]",
    outputs: "[sticker]",
  },
  ]
  let complexFilters = [{
    filter: "null",
    inputs: "[0:v]",
    outputs: "[sticker]"
  },]

  const meta = await ffprobePromise(input)

  const videoMeta = meta.streams.find(stream => stream.codec_type === 'video')
  isAlpha = (videoMeta.codec_name == 'gif' || videoMeta.codec_name == 'webp' || videoMeta.codec_name == 'png' || videoMeta.tags?.alpha_mode == '1')

  if (videoMeta.codec_name === 'gif' && videoMeta.width < 512 && videoMeta.height < 512 && !(isEmoji)) {
    let height = videoMeta.height
    if (videoMeta.width < 150 && videoMeta.height < 150) {
      height = 150
      complexFilters.push({
        filter: "scale",
        options: { w: 150, h: 150, force_original_aspect_ratio: "decrease", flags: "neighbor" },
        inputs: "[sticker]",
        outputs: "[sticker]",
      })
    }
    complexFilters.push({
      filter: "pad",
      options: { w: 512, h: height, x: -1, y: -1, color: "black@0" },
      inputs: "[sticker]",
    })
    var padded = true
  }
  if (videoMeta.tags && videoMeta.tags.alpha_mode === '1') {
    inputOptions.push('-c:v libvpx-vp9')
  }

  if (type && type !== 'square' && !(isAlpha)) {
    switch (type) {
      case 'circle':
        input_mask = 'circle.png'
        complexFilters = complexFilters.concat(cropFilter)
          .concat([{
            filter: "scale2ref",
            inputs: "[1:v][sticker]",
            outputs: "[mask][sticker]",
          },

          ])
        break;
      case 'rounded':
      case 'lite':
        if (type === 'lite')
          input_mask = 'lite.png'
        else
          input_mask = 'corner.png'

        firstfilter = (forceCrop) ? cropFilter : scaleFilter;
        complexFilters = complexFilters.concat(firstfilter)
          .concat([
            {
              filter: "color",
              options: { color: "white" },
              outputs: "[mask]",
            },
            {
              filter: "scale2ref",
              inputs: "[mask][sticker]",
              outputs: "[mask][sticker]",
            },
            {
              filter: "scale2ref",
              options: { w: `if(gte(iw/2,${(outputDimensions.h / 2)}),ih/2,iw/2)`, h: 'ow' },
              inputs: "[1:v][mask]",
              outputs: "[tl][mask]",
            },
            {
              filter: "split",
              options: "4",
              inputs: '[tl]',
              outputs: '[tl][tr][bl][br]'
            },
            {
              filter: "transpose",
              options: { dir: "clock" },
              inputs: '[tr]',
              outputs: '[tr]'
            },
            {
              filter: "transpose",
              options: { dir: "clock_flip" },
              inputs: '[br]',
              outputs: '[br]'
            },
            {
              filter: "transpose",
              options: { dir: "cclock" },
              inputs: '[bl]',
              outputs: '[bl]'
            },
            {
              filter: "overlay",
              options: { x: "0", y: "0", shortest: 1 },
              inputs: '[mask][tl]',
              outputs: '[mask]'
            },
            {
              filter: "overlay",
              options: { x: "W-w+1", y: "0", shortest: 1 },
              inputs: '[mask][tr]',
              outputs: '[mask]'
            },
            {
              filter: "overlay",
              options: { x: "0", y: "H-h+1", shortest: 1 },
              inputs: '[mask][bl]',
              outputs: '[mask]'
            },
            {
              filter: "overlay",
              options: { x: "W-w+1", y: "H-h+1", shortest: 1 },
              inputs: '[mask][br]',
              outputs: '[mask]'
            },
          ])
        break;
    }
    complexFilters = complexFilters.concat([
      {
        filter: "alphamerge",
        inputs: "[sticker][mask]",
      }])


  } else if (!padded) {
    finalScaleFilter = scaleFilter
    delete finalScaleFilter.outputs
    complexFilters.push(finalScaleFilter)
  }

  return new Promise((resolve, reject) => {
    const process = ffmpeg()
      .input(input)
      .addInputOptions(inputOptions)
    if (type && !(isAlpha) && input_mask) {
      process.input(input_mask);
    }

    process.on('error', (error) => {
      console.error(error.message, input, videoMeta)
      reject(error)
    })
      .on('end', () => {
        ffmpeg.ffprobe(output, (_err, metadata) => {
          resolve({
            output,
            metadata
          })
        })
      })
      .noAudio()
      .complexFilter(complexFilters)
      .outputOptions(
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p',
        '-metadata', 'title=https://t.me/fstikbot',
      )
      .output(output)
      .videoBitrate(`${bitrate}k`, true)
      .duration(2.9)

    process.run()
  })
}
