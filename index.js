require('dotenv').config({ path: './.env' })
const os = require('os')
const fs = require('fs').promises
const ffmpeg = require('fluent-ffmpeg')
const temp = require('temp').track()
const Queue = require('bull')

const numOfCpus = parseInt(process.env.MAX_PROCESS) || os.cpus().length

const convertQueue = new Queue('convert', {
  redis: { port: process.env.REDIS_PORT, host: process.env.REDIS_HOST, password: process.env.REDIS_PASSWORD }
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

  const file = await convertToWebmSticker(job.data.fileUrl, output).catch((err) => {
    err.message = `${os.hostname} ::: ${err.message}`
    done(err)
  })

  if (file) {
    const content = await fs.readFile(file.output, { encoding: 'base64' });

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

async function convertToWebmSticker (input, output) {
  const meta = await ffprobePromise(input)

  const videoMeta = meta.streams.find(stream => stream.codec_type === 'video')

  let fileter = 'scale=512:512:force_original_aspect_ratio=decrease'

  if (videoMeta.codec_name === 'gif' && videoMeta.width < 512 && videoMeta.height < 512) {
    let scale = ''
    let height = videoMeta.height
    if (videoMeta.width < 150 && videoMeta.height < 150) {
      height = 150
      scale = 'scale=150:150:force_original_aspect_ratio=decrease:flags=neighbor,'
    }
    fileter = scale + `pad=512:${height}:-1:-1:color=black@0`
  }

  return new Promise((resolve, reject) => {
    const process = ffmpeg()
      .input(input)
      .on('error', (error) => {
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
      .addInputOptions(['-t 3'])
      .output(output)
      .videoFilters(
        fileter
        // 'fps=30'
      )
      .videoBitrate('400k')
      .outputOptions(
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p'
      )
      .duration(2.9)

    process.run()
  })
}
