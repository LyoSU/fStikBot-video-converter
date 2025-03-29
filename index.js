require('dotenv').config({ path: './.env' })
const { exec } = require('node:child_process')
const os = require('os')
const fs = require('fs'),
    fsp = fs.promises;
const ffmpeg = require('fluent-ffmpeg')
const temp = require('temp').track()
const got = require('got')
const Queue = require('bull')
const path = require('path')


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

async function modifyWebmFileDuration(filePath) {
  // Read in the file as a buffer
  const fileBuffer = await fs.promises.readFile(filePath);

  // Find the position of the duration in the buffer
  const durationPosition = fileBuffer.indexOf(Buffer.from('4489', 'hex')); // 44 89 is the hex code for the duration in the WebM file

  // Write the new duration to the buffer
  fileBuffer.writeUInt32LE(1000000, durationPosition + 4);

  // Write the updated buffer to disk
  await fs.promises.writeFile(filePath, fileBuffer);
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

  // Гарантуємо, що шлях існує і є доступним
  const tmpDir = os.tmpdir();
  const outputFile = path.join(tmpDir, `sticker-${Date.now()}-${Math.round(Math.random() * 1000)}.webm`);

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

  // Завантажимо файл локально перед обробкою
  const localInput = path.join(tmpDir, `input-${Date.now()}-${Math.round(Math.random() * 1000)}.mp4`);

  try {
    await asyncExecFile('curl', ['-s', input, '-o', localInput]);
    console.log("Файл завантажено:", localInput);
  } catch (err) {
    console.error("Помилка завантаження файлу:", err);
    err.message = `${os.hostname} ::: ${err.message}`;
    return done(err);
  }

  const file = await simpleConvertToWebm(
    localInput,
    outputFile,
    isEmoji ? (isEmoji ? 100 : 512) : 512,
    isEmoji ? 3 : maxDuration,
    bitrate,
    job.data.frameType
  ).catch((err) => {
    err.message = `${os.hostname} ::: ${err.message}`;
    done(err);
    return null;
  });

  // Видаляємо вхідний файл
  await fsp.unlink(localInput).catch(() => {});

  if (file) {
    let fileConent, tempModified;

    if (!job.data.isEmoji && file.duration > 3) {
      tempModified = path.join(tmpDir, `modified-${Date.now()}-${Math.round(Math.random() * 1000)}.webm`);

      await fsp.copyFile(outputFile, tempModified).catch((err) => {
        console.error(err);
        done(err);
        return;
      });

      await modifyWebmFileDuration(tempModified).catch((err) => {
        console.error(err);
        done(err);
        return;
      });

      fileConent = tempModified;
    } else {
      if (job.data.isEmoji && file.duration > 3) {
        const tempTrimmed = path.join(tmpDir, `trimmed-${Date.now()}-${Math.round(Math.random() * 1000)}.webm`);

        // trim to 2.9 seconds
        await asyncExecFile('ffmpeg', [
          '-i', outputFile,
          '-ss', '0',
          '-t', '2.9',
          '-c', 'copy',
          tempTrimmed
        ]).catch((err) => {
          console.error(err);
          done(err);
          return;
        });

        await fsp.unlink(outputFile).catch(() => {});
        fileConent = tempTrimmed;
      } else {
        fileConent = outputFile;
      }
    }

    const content = await fsp.readFile(fileConent, { encoding: 'base64' }).catch((err) => {
      console.error(err);
      done(err);
      return;
    });

    if (content) {
      done(null, {
        metadata: file.metadata,
        content,
        input: job.data.input
      });
    } else {
      done(new Error('Failed to read content'));
    }

    if (tempModified) {
      await fsp.unlink(tempModified).catch(() => {});
    }
  }

  await fsp.unlink(outputFile).catch(() => {});
  console.timeEnd(consoleName);
});

// Спрощена функція конвертації за допомогою CLI FFmpeg замість fluent-ffmpeg
async function simpleConvertToWebm(inputFile, outputFile, size, maxDuration, bitrate, frameType) {
  // Перевіряємо інформацію про відео
  const metaResult = await asyncExecFile('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputFile
  ]);

  const metadata = JSON.parse(metaResult.stdout);
  const videoStream = metadata.streams.find(s => s.codec_type === 'video');

  if (!videoStream) {
    throw new Error('No video stream found');
  }

  // Визначаємо тривалість
  let duration = 0;
  if (metadata.format && metadata.format.duration) {
    duration = parseFloat(metadata.format.duration);
    if (duration > maxDuration) duration = maxDuration;
  }

  // Коригуємо бітрейт залежно від тривалості
  if (duration > 3) {
    if (size <= 100) { // isEmoji
      bitrate = ((5 * 8192) / duration) / 100;
    } else {
      bitrate = ((17 * 8192) / duration) / 100;
    }
  }

  // Базові аргументи FFmpeg
  let args = [
    '-i', inputFile,
    '-t', duration.toString(),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-b:v', `${Math.round(bitrate)}k`,
    '-maxrate', `${Math.round(bitrate * 1.5)}k`,
    '-bufsize', '300k',
    '-cpu-used', '2',
    '-row-mt', '1',
    '-deadline', 'good',
    '-crf', '40',
    '-an',  // Без аудіо
    '-fs', '255000'  // Максимальний розмір файлу
  ];

  // Аргументи для маштабування
  args.push('-vf');

  let filterString = '';

  if (frameType === 'circle') {
    // Для круглого стікера
    filterString = `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(sqrt(pow(X-${size}/2,2)+pow(Y-${size}/2,2)),${size}/2),0,255)'`;
  } else if (frameType === 'rounded' || frameType === 'medium' || frameType === 'lite') {
    // Для стікера із заокругленими кутами
    let radius;
    if (frameType === 'lite') radius = Math.round(size * 0.1);
    else if (frameType === 'medium') radius = Math.round(size * 0.2);
    else radius = Math.round(size * 0.3);

    filterString = `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=white@0,format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,${radius})*lt(Y,${radius})*lt(sqrt(pow(${radius}-X,2)+pow(${radius}-Y,2)),${radius}),255,if(lt(X,${radius})*gt(Y,${size-radius})*lt(sqrt(pow(${radius}-X,2)+pow(Y-(${size-radius}),2)),${radius}),255,if(gt(X,${size-radius})*lt(Y,${radius})*lt(sqrt(pow(X-(${size-radius}),2)+pow(${radius}-Y,2)),${radius}),255,if(gt(X,${size-radius})*gt(Y,${size-radius})*lt(sqrt(pow(X-(${size-radius}),2)+pow(Y-(${size-radius}),2)),${radius}),255,if(lt(X,${radius}),255,if(lt(Y,${radius}),255,if(gt(X,${size-radius}),255,if(gt(Y,${size-radius}),255,255)))))))))'`;
  } else {
    // Звичайний стікер
    filterString = `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=white@0`;
  }

  args.push(filterString);
  args.push(outputFile);

  console.log('Запуск FFmpeg з аргументами:', args.join(' '));

  await asyncExecFile('ffmpeg', args);

  // Перевіряємо створений файл
  const output = await asyncExecFile('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    outputFile
  ]);

  const outputMetadata = JSON.parse(output.stdout);
  console.log('file size', (outputMetadata.format.size / 1024).toFixed(2), 'kb');

  return {
    output: outputFile,
    metadata: outputMetadata,
    duration: parseFloat(outputMetadata.format.duration)
  };
}
