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
  async function internalTranslate(texts: string[], targetLanguage: string, apiKey: string, providerId: string, providerConfig: any, model: string, signal?: AbortSignal) {
    if (texts.length === 0) return [];
    if (signal?.aborted) throw new Error("Translation aborted by client");
    
    // Sanitize inputs for small models: remove newlines/quotes that break JSON
    const sanitizedTexts = texts.map(t => t.replace(/[\r\n\t]/g, ' ').replace(/"/g, "'").trim());

    const prompt = `Translate this JSON array to ${targetLanguage}. 
Return ONLY the translated JSON array. 
Format: ["text1", "text2"]

JSON to translate:
${JSON.stringify(sanitizedTexts)}`;

    let resultText = "";
    let retries = 2;
    
    while (retries >= 0) {
      if (signal?.aborted) throw new Error("Translation aborted by client");
      try {
        if (providerId === 'gemini') {
          const ai = new GoogleGenAI({ apiKey: apiKey });
          const response = await ai.models.generateContent({
            model: model,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
          });
          resultText = response.text?.trim() || "[]";
        } else {
          const openai = new OpenAI({ 
            apiKey: apiKey || 'dummy-key', 
            baseURL: providerConfig.baseURL || undefined
          });
          const response = await openai.chat.completions.create({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.05, // Near deterministic
          }, { signal }); // Pass signal to OpenAI client
          resultText = response.choices[0]?.message?.content?.trim() || "[]";
        }

        // Robust Parsing
        resultText = resultText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
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
        throw new Error("Length mismatch");
      } catch (e) {
        console.warn(`[Translate] Retry ${2-retries} failed for ${model}:`, e.message);
        retries--;
        if (retries < 0) return texts; // Final fallback
      }
    }
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
    
    // Create an AbortController to stop processing if client disconnects
    const abortController = new AbortController();
    req.on('close', () => {
      console.log(`[Dify Request] Client disconnected prematurely. Aborting translation task.`);
      abortController.abort();
    });

    try {
      const file = req.file;
      let { target_lang, provider_id, model_id, api_key } = req.body;

      // Debug logging for incoming request
      console.log(`[Dify Request] Headers:`, JSON.stringify(req.headers));
      console.log(`[Dify Request] Body Keys:`, Object.keys(req.body));
      
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
            /ppt\/diagrams\/.+\.xml/
          ], 
          textTag: 'a:t' 
        };
      }

      const xmlFiles = Object.keys(zip.files).filter(name => 
        formatConfig.xmlPaths.some(regex => regex.test(name))
      );

      // Process files with concurrency and dynamic batching
      const CONCURRENCY_LIMIT = 2; // Lower concurrency for stability on small models
      const translationCache = new Map<string, string>();
      let totalNodesTranslated = 0;
      let totalNodesSkipped = 0;

      for (const xmlPath of xmlFiles) {
        const content = await zip.file(xmlPath)?.async('string');
        if (!content) continue;

        const doc = new DOMParser().parseFromString(content, 'application/xml');
        const tNodes = Array.from(doc.getElementsByTagName(formatConfig.textTag));
        
        const nodesToTranslate: Element[] = [];
        
        tNodes.forEach(node => {
          const text = (node.textContent || "").trim();
          // Skip empty strings, pure numbers, or simple punctuation
          if (text.length > 0 && /[a-zA-Z\u4e00-\u9fa5]/.test(text)) {
            if (translationCache.has(text)) {
              node.textContent = translationCache.get(text)!;
              totalNodesSkipped++;
            } else {
              nodesToTranslate.push(node);
            }
          } else {
            totalNodesSkipped++; // No translation needed
          }
        });

        if (nodesToTranslate.length === 0) {
          const serializer = new XMLSerializer();
          zip.file(xmlPath, serializer.serializeToString(doc));
          continue;
        }

        // Dynamic batching: limit by both item count and character count
        const batches: Element[][] = [];
        let currentBatch: Element[] = [];
        let currentChars = 0;
        const MAX_CHARS = 1000;
        const MAX_ITEMS = 15;

        for (const node of nodesToTranslate) {
          const text = (node.textContent || "").trim();
          if (currentBatch.length >= MAX_ITEMS || currentChars + text.length > MAX_CHARS) {
            if (currentBatch.length > 0) {
              batches.push(currentBatch);
              currentBatch = [];
              currentChars = 0;
            }
          }
          currentBatch.push(node);
          currentChars += text.length;
        }
        if (currentBatch.length > 0) batches.push(currentBatch);

        console.log(`[Process] ${xmlPath}: ${batches.length} batches to translate. (Skipped ${totalNodesSkipped} cached/unneeded nodes)`);

        for (let i = 0; i < batches.length; i += CONCURRENCY_LIMIT) {
          const currentChunks = batches.slice(i, i + CONCURRENCY_LIMIT);
          await Promise.all(currentChunks.map(async (batch) => {
            const texts = batch.map(n => (n.textContent || "").trim());
            
            // Double check cache in case a concurrent batch translated it
            const textsToFetch = texts.map(t => translationCache.has(t) ? translationCache.get(t)! : t);
            const needsFetch = texts.some(t => !translationCache.has(t));

            let translated: string[] = textsToFetch;

            if (needsFetch) {
              translated = await internalTranslate(
                texts, 
                target_lang || 'Chinese', 
                finalApiKey, 
                provider_id, 
                providerConfig, 
                finalModel,
                abortController.signal
              );
            }

            batch.forEach((node, idx) => {
              const originalText = texts[idx];
              const transText = translated[idx];
              if (transText && transText !== originalText) {
                node.textContent = transText;
                translationCache.set(originalText, transText);
              }
              totalNodesTranslated++;
            });
          }));
          
          if ((i + CONCURRENCY_LIMIT) % 4 === 0 || i + CONCURRENCY_LIMIT >= batches.length) {
             console.log(`[Progress] ${xmlPath}: Translated ${Math.min(i + CONCURRENCY_LIMIT, batches.length)} / ${batches.length} batches...`);
          }
        }

        const serializer = new XMLSerializer();
        zip.file(xmlPath, serializer.serializeToString(doc));
      }
      console.log(`[Done] Translation complete. Translated: ${totalNodesTranslated}, Skipped/Cached: ${totalNodesSkipped}`);

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
  server.timeout = 600000; // 10 minutes timeout for long document translations
}

startServer();
