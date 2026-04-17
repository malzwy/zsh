import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import multer from 'multer';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  // Helper for batch translation (internal use)
  async function internalTranslate(texts: string[], targetLanguage: string, apiKey: string, providerId: string, providerConfig: any, model: string, abortSignal?: AbortSignal) {
    if (texts.length === 0) return [];
    
    // Sanitize inputs for small models: remove newlines/quotes that break JSON
    const sanitizedTexts = texts.map(t => t.replace(/[\r\n\t]/g, ' ').replace(/"/g, "'").trim());

    console.log(`[Translate] Using provider: ${providerId}, model: ${model}, baseURL: ${providerConfig?.baseURL}`);

    const prompt = `Translate the following JSON array of strings to ${targetLanguage}. 
Requirements:
1. Return ONLY a valid JSON array of strings.
2. Maintain the exact same number of elements.
3. Do not include any explanations, markdown formatting, or extra text.
4. If a string is already in ${targetLanguage}, keep it as is.

JSON to translate:
${JSON.stringify(sanitizedTexts)}`;

    let resultText = "";
    let retries = 2;
    
    while (retries >= 0) {
      if (abortSignal?.aborted) {
         throw new Error("AbortError: Translation aborted by client");
      }
      try {
        if (providerId === 'gemini') {
          const ai = new GoogleGenAI({ apiKey: apiKey });
          const responseStream = await ai.models.generateContentStream({
            model: model,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
          });
          for await (const chunk of responseStream) {
              if (abortSignal?.aborted) throw new Error("AbortError: Translation aborted by client");
              resultText += chunk.text || "";
          }
        } else {
          const openai = new OpenAI({ 
            apiKey: apiKey || 'dummy-key', 
            baseURL: providerConfig.baseURL || undefined,
            timeout: 60000 // 60s timeout for Ollama
          });
          // Use stream: true to force Ollama to detect broken pipe immediately on client disconnect
          const streamResponse = await openai.chat.completions.create({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            stream: true,
          }, { signal: abortSignal });

          for await (const chunk of streamResponse) {
              if (abortSignal?.aborted) throw new Error("AbortError: Translation aborted by client");
              resultText += chunk.choices[0]?.delta?.content || "";
          }
        }

        // Robust Parsing for DeepSeek/Ollama
        console.log(`[Translate] Raw response (first 100 chars): ${resultText.substring(0, 100)}...`);
        
        // Remove <think> blocks
        resultText = resultText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        
        // Extract JSON from markdown blocks if present
        const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          resultText = jsonMatch[1].trim();
        }

        const startArr = resultText.indexOf('[');
        const endArr = resultText.lastIndexOf(']');
        if (startArr !== -1 && endArr !== -1 && endArr > startArr) {
          resultText = resultText.substring(startArr, endArr + 1);
        }
        resultText = resultText.replace(/,\s*\]/g, ']'); 

        const translated = JSON.parse(resultText);
        if (Array.isArray(translated) && translated.length === sanitizedTexts.length) {
          return translated;
        }
        console.error(`[Translate] Length mismatch or not an array. Expected ${sanitizedTexts.length}, got ${Array.isArray(translated) ? translated.length : 'not an array'}`);
        throw new Error("Length mismatch or invalid format");
      } catch (e: any) {
        if (e.name === 'AbortError' || e.message?.includes('AbortError')) {
           console.log(`[Translate] Early termination triggered. Throwing AbortError immediately.`);
           throw e; // Break completely out of everything
        }
        console.warn(`[Translate] Attempt ${3-retries} failed for ${model}:`, e.message);
        if (resultText) console.warn(`[Translate] Failed resultText snippet: ${resultText.substring(0, 200)}`);
        retries--;
      }
    }
    console.error(`[Translate] All retries failed for batch. Returning original text.`);
    return texts;
  }

  // API route to get configuration
  app.get('/api/config', async (req, res) => {
    try {
      const configPath = path.join(__dirname, 'config.json');
      const configData = await fs.readFile(configPath, 'utf-8');
      res.json(JSON.parse(configData));
    } catch (error) {
      console.error('Error reading config:', error);
      res.status(500).json({ error: 'Failed to load configuration' });
    }
  });

  // Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Dify-compatible Document Translation API (Optimized for Sync Response)
  app.post('/api/v1/translate-doc', upload.single('file'), async (req, res) => {
    req.setTimeout(0); // Disable timeout for large files
    res.setTimeout(0);

    try {
      const file = req.file;
      let { target_lang, provider_id, model_id, api_key } = req.body;

      // Debug logging for incoming request
      console.log(`[Dify Request] Headers:`, JSON.stringify(req.headers));
      console.log(`[Dify Request] Body:`, JSON.stringify({ ...req.body, api_key: req.body.api_key ? '***' : undefined }));
      
      if (!file) {
        console.error("[Dify Error] No file object in request");
        return res.status(400).json({ error: "No file uploaded. Please check if the 'file' parameter type is set to 'File' in Dify." });
      }

      if (file.size < 500) {
        console.error(`[Dify Error] File received but too small (${file.size} bytes). Dify sent a placeholder instead of binary.`);
        return res.status(400).json({ error: `File content missing. Received only ${file.size} bytes. Ensure Dify HTTP node is sending the actual file binary. Check the 'file' field type is set to 'File' in Dify form-data settings.` });
      }
      
      const configPath = path.join(__dirname, 'config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      
      // Smart Provider Selection: If not provided, find the first one with a key
      if (!provider_id) {
        const availableProviders = Object.keys(config.providers).filter(p => config.providers[p].defaultKey);
        provider_id = availableProviders.includes('ollama') ? 'ollama' : (availableProviders[0] || 'gemini');
        console.log(`[Dify] No provider_id sent, auto-selected: ${provider_id}`);
      }

      const providerConfig = config.providers[provider_id];
      if (!providerConfig) {
        throw new Error(`Provider '${provider_id}' not found in configuration.`);
      }
      
      const finalApiKey = api_key || providerConfig.defaultKey;
      const finalModel = model_id || providerConfig.models[0].id;

      console.log(`[Dify] Translating ${file.originalname} to ${target_lang || 'Chinese'} using ${provider_id}/${finalModel}`);

      const zip = await JSZip.loadAsync(file.buffer);
      const extension = path.extname(file.originalname).toLowerCase();
      console.log(`[Dify] Processing file: ${file.originalname}, Extension: ${extension}`);
      
      let formatConfig = {
        xmlPaths: [/word\/document\.xml/],
        textTag: 'w:t'
      };

      if (extension === '.docx') {
        formatConfig = { 
          xmlPaths: [
            /word\/document\.xml/,
            /word\/header\d+\.xml/,
            /word\/footer\d+\.xml/,
            /word\/footnotes\.xml/,
            /word\/endnotes\.xml/
          ], 
          textTag: 'w:t' 
        };
      } else if (extension === '.xlsx') {
        formatConfig = { 
          xmlPaths: [
            /xl\/worksheets\/sheet\d+\.xml/,
            /xl\/sharedStrings\.xml/
          ], 
          textTag: 't' 
        };
      } else if (extension === '.pptx') {
        formatConfig = { 
          xmlPaths: [
            /ppt\/slides\/slide\d+\.xml/,
            /ppt\/notesSlides\/notesSlide\d+\.xml/,
            /ppt\/slides\/_rels\/slide\d+\.xml\.rels/,
            /ppt\/theme\/theme\d+\.xml/,
            /ppt\/diagrams\/.+\.xml/,
            /ppt\/slideMasters\/slideMaster\d+\.xml/,
            /ppt\/slideLayouts\/slideLayout\d+\.xml/
          ], 
          textTag: 'a:t' 
        };
      }

      const xmlFiles = Object.keys(zip.files).filter(name => 
        formatConfig.xmlPaths.some(regex => regex.test(name))
      );
      console.log(`[Dify] Found ${xmlFiles.length} XML files to process:`, xmlFiles);

      // Process files with concurrency and dynamic batching
      const CONCURRENCY_LIMIT = 5; // Increased concurrency for faster translation
      const translationCache = new Map<string, string>();
      let totalNodesTranslated = 0;
      let totalNodesSkipped = 0;
      let isClientDisconnected = false;
      const abortController = new AbortController();

      // Listen for client disconnect to stop processing
      req.on('close', () => {
        console.log(`[Dify] Client disconnected prematurely. Stopping translation for ${file.originalname}`);
        isClientDisconnected = true;
        abortController.abort();
      });

    for (const xmlPath of xmlFiles) {
        if (isClientDisconnected) break;
        const content = await zip.file(xmlPath)?.async('string');
        if (!content) continue;

        const doc = new DOMParser().parseFromString(content, 'application/xml');
        
        // Find Paragraph Containers for Grouping
        const paragraphTag = (extension === '.docx') ? 'w:p' : (extension === '.pptx' ? 'a:p' : null);
        
        interface TextGroup {
          originalNodes: Element[];
          mergedText: string;
        }
        const groupsToTranslate: TextGroup[] = [];
        
        if (paragraphTag) {
          // Paragraph-level grouping for DOCX/PPTX to preserve context and handle split runs
          const paragraphs = Array.from(doc.getElementsByTagName(paragraphTag));
          paragraphs.forEach(p => {
            const tNodes = Array.from(p.getElementsByTagName(formatConfig.textTag));
            if (tNodes.length === 0) return;

            const mergedText = tNodes.map(n => n.textContent || "").join("");
            const trimmedText = mergedText.trim();

            if (trimmedText.length > 0 && /[a-zA-Z\u4e00-\u9fa5]/.test(trimmedText)) {
              if (translationCache.has(mergedText)) {
                // Apply cached translation to the full paragraph
                const cached = translationCache.get(mergedText)!;
                tNodes[0].textContent = cached;
                for (let j = 1; j < tNodes.length; j++) tNodes[j].textContent = "";
                totalNodesSkipped += tNodes.length;
              } else {
                groupsToTranslate.push({ originalNodes: tNodes, mergedText: mergedText });
              }
            } else {
              totalNodesSkipped += tNodes.length;
            }
          });
        } else {
          // XLSX or fallback: Treat every node as independent
          const tNodes = Array.from(doc.getElementsByTagName(formatConfig.textTag));
          tNodes.forEach(node => {
            const text = (node.textContent || "").trim();
            if (text.length > 0 && /[a-zA-Z\u4e00-\u9fa5]/.test(text)) {
              if (translationCache.has(text)) {
                node.textContent = translationCache.get(text)!;
                totalNodesSkipped++;
              } else {
                groupsToTranslate.push({ originalNodes: [node], mergedText: text });
              }
            } else {
              totalNodesSkipped++;
            }
          });
        }

        console.log(`[Dify] XML file ${xmlPath}: Found ${groupsToTranslate.length} groups to translate.`);

        if (groupsToTranslate.length === 0) {
          const serializer = new XMLSerializer();
          zip.file(xmlPath, serializer.serializeToString(doc));
          continue;
        }

        // Dynamic batching: limit by both group count and character count
        const batches: TextGroup[][] = [];
        let currentBatch: TextGroup[] = [];
        let currentChars = 0;
        const MAX_CHARS = 4000; // Increased limit slightly for merged paragraphs
        const MAX_ITEMS = 25;

        for (const group of groupsToTranslate) {
          if (currentBatch.length >= MAX_ITEMS || currentChars + group.mergedText.length > MAX_CHARS) {
            if (currentBatch.length > 0) {
              batches.push(currentBatch);
              currentBatch = [];
              currentChars = 0;
            }
          }
          currentBatch.push(group);
          currentChars += group.mergedText.length;
        }
        if (currentBatch.length > 0) batches.push(currentBatch);

        console.log(`[Process] ${xmlPath}: ${batches.length} batches to translate.`);

        for (let i = 0; i < batches.length; i += CONCURRENCY_LIMIT) {
          if (isClientDisconnected) break;
          const currentChunks = batches.slice(i, i + CONCURRENCY_LIMIT);
          await Promise.all(currentChunks.map(async (batch) => {
            const texts = batch.map(g => g.mergedText);
            
            let translated: string[] = [];
            try {
              translated = await internalTranslate(
                texts, 
                target_lang || 'Chinese', 
                finalApiKey, 
                provider_id, 
                providerConfig, 
                finalModel,
                abortController.signal
              );
            } catch (err: any) {
              if (err.name === 'AbortError' || err.message?.includes('AbortError')) throw err;
              console.warn(`[Process] Batch failed, using original text.`);
              translated = texts;
            }

            batch.forEach((group, idx) => {
              const original = group.mergedText;
              const trans = translated[idx];
              if (trans && trans !== original) {
                // In paragraph mode, we put the full translation into the first node and clear the others
                group.originalNodes[0].textContent = trans;
                for (let k = 1; k < group.originalNodes.length; k++) {
                  group.originalNodes[k].textContent = "";
                }
                translationCache.set(original, trans);
              }
              totalNodesTranslated += group.originalNodes.length;
            });
          }));
          
          if ((i + CONCURRENCY_LIMIT) % 4 === 0 || i + CONCURRENCY_LIMIT >= batches.length) {
             console.log(`[Progress] ${xmlPath}: Processed ${Math.min(i + CONCURRENCY_LIMIT, batches.length)} / ${batches.length} batches...`);
          }
        }

        const serializer = new XMLSerializer();
        zip.file(xmlPath, serializer.serializeToString(doc));
      }
      if (isClientDisconnected) {
        return; // Response is already closed, just exit the function
      }

      console.log(`[Done] Translation complete. File: ${file.originalname}, Translated: ${totalNodesTranslated}, Skipped/Cached: ${totalNodesSkipped}`);

      const outputBuffer = await zip.generateAsync({ 
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });
      
      // Set headers for direct file download in Dify
      const ext = path.extname(file.originalname);
      const baseName = path.basename(file.originalname, ext);
      const langSuffix = target_lang || 'Chinese';
      const outputFileName = `${baseName}_${langSuffix}${ext}`;

      res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"; filename*=UTF-8''${encodeURIComponent(outputFileName)}`);
      res.send(outputBuffer);

    } catch (error: any) {
      console.error("Dify API Error:", error);
      // Return 400 instead of 500 so Dify doesn't retry and shows the actual error message
      res.status(400).json({ 
        error: error.message || "Internal server error during document translation",
        hint: "If you see this in Dify, check if the file was sent correctly."
      });
    }
  });

  // Download endpoint
  app.get('/api/v1/download/:fileName', async (req, res) => {
    try {
      const fileName = req.params.fileName;
      const filePath = path.join(__dirname, 'dist', 'outputs', fileName);
      
      await fs.access(filePath);
      res.download(filePath);
    } catch (error) {
      res.status(404).json({ error: "File not found" });
    }
  });

  // API route to proxy translation requests (solves CORS and Mixed Content)
  app.post('/api/translate', async (req, res) => {
    try {
      const { texts, targetLanguage, apiKey, providerId, providerConfig, model } = req.body;
      
      if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return res.json({ translatedTexts: [] });
      }

      const translatedTexts = await internalTranslate(
        texts, 
        targetLanguage, 
        apiKey, 
        providerId, 
        providerConfig, 
        model
      );

      res.json({ translatedTexts });
    } catch (error: any) {
      console.error("Backend Translation error:", error);
      res.status(500).json({ 
        error: error.message, 
        status: error.status || 500
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  server.timeout = 0; // Disable Node.js server timeout completely
  server.keepAliveTimeout = 0; // Disable keep-alive timeout
}

startServer();
