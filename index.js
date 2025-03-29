require('dotenv').config({ path: './.env' })
const { exec } = require('node:child_process')
const os = require('os')
const fs = require('fs'),
    fsp = fs.promises;
const ffmpeg = require('fluent-ffmpeg')
const temp = require('temp').track()
const got = require('got')
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

// Функція для модифікації тривалості WebM файлів
// Модифікована для кращої підтримки в FFmpeg 7
async function modifyWebmFileDuration(filePath) {
  try {
    // Читаємо файл як буфер
    const fileBuffer = await fs.promises.readFile(filePath);

    // Знаходимо позицію тривалості у буфері
    const durationPosition = fileBuffer.indexOf(Buffer.from('4489', 'hex')); // 44 89 - це hex-код для тривалості у WebM файлі

    if (durationPosition === -1) {
      console.warn('Не вдалося знайти дані тривалості у WebM файлі');
      return;
    }

    // Записуємо нову тривалість у буфер
    fileBuffer.writeUInt32LE(1000000, durationPosition + 4);

    // Записуємо оновлений буфер на диск
    await fs.promises.writeFile(filePath, fileBuffer);
    console.log('Тривалість WebM файлу була успішно модифікована');
  } catch (err) {
    console.error('Помилка при модифікації тривалості WebM файлу:', err);
    throw err;
  }
}


const redisConfig =  {
  port: process.env.REDIS_PORT,
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASSWORD
}

const removebgQueue = new Queue('removebg', {
  redis: redisConfig
})

if (os.platform() === '1darwin') {
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
    // if timestamp > 10 seconds ago, skip
    if (job.timestamp < Date.now() - 1000 * 10) {
      return done(new Error('timeout'))
    }

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

    await fsp.unlink(tempInput).catch((() => {}))

    const file = output.stdout

    const content = await fsp.readFile(file, { encoding: 'base64' }).catch((err) => {
      console.error(err)
      done(err)
    });

    await fsp.unlink(file).catch((() => {}))

    if (content) {
      done(null, {
        content
      })
    } else {
      done(new Error('removebg failed'))
    }
  })
} else {
  got.get(`${process.env.REMBG_URL}/docs`).then((res) => {
    if (res.statusCode !== 200) {
      console.error('rembg server is down')
      return
    }

    removebgQueue.process(numOfCpus, async (job, done) => {
      const consoleName = `🖼️  job removebg #${job.id}`

      console.time(consoleName)
      const { fileUrl, model } = job.data

      const params = new URLSearchParams({
        url: fileUrl,
        model: model || 'silueta'
      })

      const result = await got(`${process.env.REMBG_URL}/?${params.toString()}`, {
        responseType: 'buffer',
        timeout: 1000 * 15
      }).catch((err) => {
        console.error(err)
        return err.response
      })

      if (result?.statusCode !== 200) {
        done(new Error('removebg failed'))
        return
      }

      const content = result.body.toString('base64')

      console.timeEnd(consoleName)

      done(null, {
        content
      })
    })
  }).catch((err) => {
    console.error('rembg server is down')
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
    return done(new Error('timeout'))
  }

  const output = temp.path({ suffix: '.webm' })

  const consoleName = `📹 job convert #${job.id}`

  console.time(consoleName)
  let bitrate = (job.data.bitrate) || process.env.DEFAULT_BITRATE || 500
  let maxDuration = (job.data.maxDuration) || process.env.DEFAULT_MAX_DURATION || 10
  let isEmoji = (job.data.isEmoji) || false

  let input
  if (job.data.fileData) {
    input = `data:video/mp4;base64,${job.data.fileData}`
  } else {
    input = job.data.fileUrl
  }

  const file = await convertToWebmSticker(input, job.data.frameType, job.data.forceCrop, isEmoji, output, bitrate, maxDuration).catch((err) => {
    err.message = `${os.hostname} ::: ${err.message}`
    done(err)
  })

  if (file) {
    let fileConent, tempModified

    if (!job.data.isEmoji && file?.metadata?.format?.duration > 3) {
      tempModified = temp.path({ suffix: '.webm' })

      await fsp.copyFile(output, tempModified).catch((err) => {
        console.error(err)
        done(err)
      })

      // Модифікуємо тривалість WebM файлу
      await modifyWebmFileDuration(tempModified).catch((err) => {
        console.error(err)
        done(err)
      })

      fileConent = tempModified
    } else {
      if (job.data.isEmoji && file?.metadata?.format?.duration > 3) {
        const tempTrimmed = temp.path({ suffix: '.webm' })

        // trim to 2.9 seconds
        await asyncExecFile('ffmpeg', [
          // Додано явний декодер для вхідного WebM файлу
          '-c:v', 'libvpx-vp9',
          '-i', output,
          '-ss', '0',
          '-t', '2.9',
          // Явно зберігаємо формат з альфа-каналом
          '-pix_fmt', 'yuva420p',
          // Додано збереження метаданих альфа-каналу
          '-metadata:s:v', 'alpha_mode=1',
          // Вимкнено auto-alt-ref для кращої підтримки альфа-каналу
          '-auto-alt-ref', '0',
          '-c', 'copy',
          tempTrimmed
        ]).catch((err) => {
          console.error(err)
          done(err)
        })

        await fsp.unlink(output).catch(() => {})

        fileConent = tempTrimmed
      } else {
        fileConent = output
      }
    }

    const content = await fsp.readFile(fileConent, { encoding: 'base64' }).catch((err) => {
      console.error(err)
      done(err)
    });

    done(null, {
      metadata: file.metadata,
      content,
      input: job.data.input
    })

    if (tempModified) {
      await fsp.unlink(tempModified).catch(() => {})
    }
  }

  await fsp.unlink(output).catch(() => {})

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

async function convertToWebmSticker(input, frameType, forceCrop, isEmoji, output, bitrate, maxDuration) {
  if (isEmoji) {
    maxDuration = 3
  }

  // Додано явний декодер для вхідних файлів для кращої підтримки альфа-каналу
  const inputOptions = [`-t ${maxDuration}`, '-c:v', 'libvpx-vp9']

  let outputDimensions = { w: 512, h: 512 }
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

  let complexFilters = [
    {
      filter: "null",
      inputs: "[0:v]",
      outputs: "[sticker]"
    },
  ]

  const meta = await ffprobePromise(input)

  let duration = (meta.format.duration === 'N/A' ? 0 : parseFloat(meta.format.duration)) || maxDuration
  if (duration > maxDuration) duration = maxDuration

  if (duration > 3) {
    if (isEmoji) {
      bitrate = ((5 * 8192) / duration) / 100
    } else {
      bitrate = ((17 * 8192) / duration) / 100
    }
  }

  const videoMeta = meta.streams.find(stream => stream.codec_type === 'video')

  // Перевірка на наявність alpha_mode в метаданих
  let isAlpha = (videoMeta.codec_name == 'gif' || videoMeta.codec_name == 'webp' || videoMeta.codec_name == 'png' ||
                videoMeta.tags?.alpha_mode == '1')

  // Додаткова перевірка на формат пікселів
  if (videoMeta.pix_fmt && videoMeta.pix_fmt.includes('yuva')) {
    isAlpha = true
  }

  if ((videoMeta.codec_name === 'gif' || isAlpha) && videoMeta.width < 512 && videoMeta.height < 512 && !(isEmoji)) {
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
      options: { w: 512, h: height, x: -1, y: -1, color: "white@0" },
      inputs: "[sticker]",
    })
    var padded = true
  }

  // Встановлюємо правильний декодер в залежності від типу відео
  if (videoMeta.tags && videoMeta.tags.alpha_mode === '1') {
    if (videoMeta.codec_name === 'vp9') {
      inputOptions.push('-c:v', 'libvpx-vp9')
    } else {
      inputOptions.push('-c:v', 'libvpx')
    }
  }

  let input_mask

  if (frameType && frameType !== 'square' && !(isAlpha)) {
    switch (frameType) {
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
      case 'medium':
      case 'lite':
        if (frameType === 'lite')
          input_mask = 'lite.png'
        else if (frameType === 'medium')
          input_mask = 'medium.png'
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
    let finalScaleFilter = scaleFilter
    delete finalScaleFilter.outputs
    if (forceCrop) {
      finalScaleFilter.inputs = "[sticker]"
      complexFilters = complexFilters.concat(cropFilter)
    }
    complexFilters.push(finalScaleFilter)
  }

  const fps = parseInt(videoMeta.r_frame_rate.split('/')[0]) / parseInt(videoMeta.r_frame_rate.split('/')[1])

  return new Promise((resolve, reject) => {
    const process = ffmpeg()
      .input(input)
      .addInputOptions(inputOptions)

    if (frameType && !(isAlpha) && input_mask) {
      process.input(input_mask);
    }

    process
      .noAudio()
      .complexFilter(complexFilters)
      .fps(Math.min(30, fps))
      .outputOptions(
        '-c:v', 'libvpx-vp9',
        // Явно вказуємо формат пікселів для збереження альфа-каналу
        '-pix_fmt', 'yuva420p',
        '-map', '0:v',
        '-map_metadata', '-1',
        // Збережемо метадані альфа-каналу
        '-metadata:s:v', 'alpha_mode=1',
        '-fflags', '+bitexact',
        '-flags:v', '+bitexact',
        '-flags:a', '+bitexact',
        '-b:v', `${bitrate}k`,
        '-maxrate', `${bitrate * 1.5}k`,
        '-bufsize', '300k',
        '-fs', '255000',
        '-crf', '40',
        // Вимкнемо auto-alt-ref для кращої підтримки альфа-каналу
        '-auto-alt-ref', '0',
        '-metadata', 'title=https://t.me/fstikbot',
      )
      .duration(duration)
      .output(output)
      .on('error', (error) => {
        console.error(error.message, input, videoMeta)
        reject(error)
      })
      .on('end', () => {
        ffmpeg.ffprobe(output, (_err, metadata) => {
          console.log('file size', (metadata?.format?.size / 1024).toFixed(2), 'kb')

          resolve({
            output,
            metadata
          })
        })
      })
      .run()
  })
}
