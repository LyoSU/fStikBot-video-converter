require('dotenv').config({ path: './.env' })
const { exec } = require('node:child_process')
const os = require('os')
const fs = require('fs'),
    fsp = fs.promises;
const ffmpeg = require('fluent-ffmpeg')
const temp = require('temp').track()
const got = require('got')
const Queue = require('bull')
const https = require('https')
const http = require('http')
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

// Download file from URL to a local temporary path
async function downloadFile(url) {
  console.log('Downloading file from URL:', url);

  return new Promise((resolve, reject) => {
    const tempPath = temp.path({ suffix: path.extname(url) || '.mp4' });

    const protocol = url.startsWith('https:') ? https : http;

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        try {
          return resolve(downloadFile(response.headers.location));
        } catch (redirectErr) {
          return reject(redirectErr);
        }
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download file: ${response.statusCode}`));
      }

      const fileStream = fs.createWriteStream(tempPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        console.log('File downloaded successfully to:', tempPath);
        resolve(tempPath);
      });

      fileStream.on('error', (err) => {
        fs.unlink(tempPath, () => {}); // Delete the file on error
        reject(err);
      });
    });

    request.on('error', (err) => {
      fs.unlink(tempPath, () => {}); // Delete the file on error
      reject(err);
    });

    request.end();
  });
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
  got.get(process.env.REMBG_URL).then((res) => {
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

      const result = await got(`${process.env.REMBG_URL}/api/remove?${params.toString()}`, {
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
  let downloadedInputFile = null;

  const consoleName = `📹 job convert #${job.id}`

  console.time(consoleName)
  let bitrate = (job.data.bitrate) || process.env.DEFAULT_BITRATE || 500
  let maxDuration = (job.data.maxDuration) || process.env.DEFAULT_MAX_DURATION || 10
  let isEmoji = (job.data.isEmoji) || false

  let input
  try {
    if (job.data.fileData) {
      input = `data:video/mp4;base64,${job.data.fileData}`
    } else {
      // Check if input is an HTTPS URL
      if (job.data.fileUrl && job.data.fileUrl.startsWith('https://')) {
        try {
          // Try to download the file first to handle HTTPS URLs
          downloadedInputFile = await downloadFile(job.data.fileUrl);
          input = downloadedInputFile;
        } catch (downloadError) {
          console.error('Error downloading file, falling back to direct URL:', downloadError);
          input = job.data.fileUrl;
        }
      } else {
        input = job.data.fileUrl;
      }
    }

    const file = await convertToWebmSticker(input, job.data.frameType, job.data.forceCrop, isEmoji, output, bitrate, maxDuration).catch((err) => {
      err.message = `${os.hostname} ::: ${err.message}`
      done(err)
      return null;
    })

    if (file) {
      let fileConent, tempModified

      if (!job.data.isEmoji && file?.metadata?.format?.duration > 3) {
        tempModified = temp.path({ suffix: '.webm' })

        await fsp.copyFile(output, tempModified).catch((err) => {
          console.error(err)
          done(err)
        })

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
            '-i', output,
            '-ss', '0',
            '-t', '2.9',
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

    // Clean up downloaded input file if it exists
    if (downloadedInputFile) {
      await fsp.unlink(downloadedInputFile).catch(() => {})
    }

    console.timeEnd(consoleName)
  } catch (error) {
    console.error('Error in job processing:', error);
    done(error);

    // Clean up downloaded input file if it exists
    if (downloadedInputFile) {
      await fsp.unlink(downloadedInputFile).catch(() => {})
    }
  }
})

const ffprobePromise = (file) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) {
        // Check if the error is related to HTTPS protocol
        if (err.message && err.message.includes('Protocol not found')) {
          reject(new Error('HTTPS protocol not supported by FFmpeg: ' + err.message));
        } else {
          reject(err);
        }
      } else {
        resolve(metadata);
      }
    });
  });
};

async function convertToWebmSticker(input, frameType, forceCrop, isEmoji, output, bitrate, maxDuration) {
  if (isEmoji) {
    maxDuration = 3
  }

  const inputOptions = [`-t ${maxDuration}`]


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

  try {
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
    if (!videoMeta) {
      throw new Error('No video stream found')
    }

    const isAlpha = (videoMeta.codec_name == 'gif' || videoMeta.codec_name == 'webp' || videoMeta.codec_name == 'png' || videoMeta.tags?.alpha_mode == '1')

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
    if (videoMeta.tags && videoMeta.tags.alpha_mode === '1') {
      inputOptions.push('-c:v libvpx-vp9')
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

    const fps = parseInt(videoMeta.r_frame_rate.split('/')[0]) / parseInt(videoMeta.r_frame_rate.split('/')[1]) || 30

    return new Promise((resolve, reject) => {
      let ffmpegProcess;
      const timeout = setTimeout(() => {
        console.error('FFmpeg process timeout - killing process');
        if (ffmpegProcess && ffmpegProcess.kill) {
          ffmpegProcess.kill('SIGKILL');
        }
        reject(new Error('FFmpeg process timed out'));
      }, (maxDuration * 1000) + 30000); // Add 30 seconds to max duration as timeout

      try {
        const process = ffmpeg()
          .input(input)
          .addInputOptions(inputOptions)

        if (frameType && !(isAlpha) && input_mask) {
          process.input(input_mask);
        }

        ffmpegProcess = process
          .noAudio()
          .complexFilter(complexFilters)
          .fps(Math.min(30, fps))
          .outputOptions(
            '-c:v', 'libvpx-vp9',
            // '-pix_fmt', 'yuva420p',
            '-map', '0:v',
            '-map_metadata', '-1',
            '-fflags', '+bitexact',
            '-flags:v', '+bitexact',
            '-flags:a', '+bitexact',
            '-b:v', `${bitrate}k`,
            '-maxrate', `${bitrate * 1.5}k`,
            '-bufsize', '300k',
            '-fs', '255000',
            '-crf', '40',
            '-metadata', 'title=https://t.me/fstikbot',
          )
          .duration(duration)
          .output(output)
          .on('start', (commandLine) => {
            console.log('FFmpeg started with command:', commandLine);
          })
          .on('progress', (progress) => {
            console.log('FFmpeg processing: ', progress.percent ? `${progress.percent.toFixed(1)}%` : 'In progress');
          })
          .on('error', (error) => {
            clearTimeout(timeout);
            console.error('FFmpeg error:', error.message, 'Input:', input);
            console.error('Video metadata:', JSON.stringify(videoMeta));
            reject(error);
          })
          .on('end', () => {
            clearTimeout(timeout);
            console.log('FFmpeg processing completed');
            ffmpeg.ffprobe(output, (probeErr, metadata) => {
              if (probeErr) {
                console.error('Error probing output file:', probeErr.message);
                return reject(probeErr);
              }

              if (!metadata || !metadata.format) {
                console.error('Invalid metadata returned from ffprobe');
                return reject(new Error('Invalid output metadata'));
              }

              console.log('File size:', (metadata.format.size / 1024).toFixed(2), 'kb');
              resolve({
                output,
                metadata
              });
            });
          })
          .run();
      } catch (runError) {
        clearTimeout(timeout);
        console.error('Error starting FFmpeg process:', runError);
        reject(runError);
      }
    });
  } catch (error) {
    console.error('Error in convertToWebmSticker:', error);
    throw error;
  }
}
