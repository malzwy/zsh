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

  // Global Translation Cache (Persistent across requests for efficiency)
const GLOBAL_TRANSLATION_CACHE = new Map<string, string>();
const MAX_CACHE_SIZE = 5000;

function addToGlobalCache(original: string, translated: string) {
    if (GLOBAL_TRANSLATION_CACHE.size >= MAX_CACHE_SIZE) {
        // Simple LRU: clear first entries if full
        const firstKey = GLOBAL_TRANSLATION_CACHE.keys().next().value;
        if (firstKey) GLOBAL_TRANSLATION_CACHE.delete(firstKey);
    }
    GLOBAL_TRANSLATION_CACHE.set(original, translated);
}

// Helper for batch translation (internal use)
async function internalTranslate(texts: string[], targetLanguage: string, apiKey: string, providerId: string, providerConfig: any, model: string, abortSignal?: AbortSignal) {
    if (texts.length === 0) return [];
    
    // Sanitize inputs for small models: remove newlines/quotes that break JSON
    const payload: Record<string, string> = {};
    texts.forEach((t, i) => { payload[`t${i}`] = t.replace(/[\r\n\t]/g, ' ').replace(/"/g, "'").trim(); });

    const isLongText = texts.some(t => t.length > 300);
    console.log(`[Translate] Using ${providerId}/${model}. longTextMode: ${isLongText}`);

    const prompt = `Translate the following JSON object's values to ${targetLanguage}. 
Requirements:
1. Return ONLY a valid JSON object.
2. Maintain the EXACT same keys (t0, t1, etc.).
3. Do not include any explanations, thoughts (<think>), markdown formatting, or extra text.
4. Keep technical terms, emails, URLs, and numbers exactly as they are.
5. Provide high-quality, natural-sounding translations.

JSON to translate:
${JSON.stringify(payload)}`;

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
            config: { 
                responseMimeType: 'application/json',
                maxOutputTokens: 4096 
            }
          });
          for await (const chunk of responseStream) {
              if (abortSignal?.aborted) throw new Error("AbortError: Translation aborted by client");
              resultText += chunk.text || "";
          }
        } else {
          const openai = new OpenAI({ 
            apiKey: apiKey || 'dummy-key', 
            baseURL: providerConfig.baseURL || undefined,
            timeout: isLongText ? 120000 : 90000 // Up to 120s for huge clusters
          });
          
          const streamResponse = await openai.chat.completions.create({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            stream: true,
            max_tokens: 4096
          }, { signal: abortSignal });

          for await (const chunk of streamResponse) {
              if (abortSignal?.aborted) throw new Error("AbortError: Translation aborted by client");
              resultText += chunk.choices[0]?.delta?.content || "";
          }
        }

        // Robust Parsing for DeepSeek/Ollama
        if (retries === 2) console.log(`[Translate] Done. response length: ${resultText.length}`);
        
        resultText = resultText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) resultText = jsonMatch[1].trim();

        const startArr = resultText.indexOf('{');
        const endArr = resultText.lastIndexOf('}');
        if (startArr !== -1 && endArr !== -1) resultText = resultText.substring(startArr, endArr + 1);

        let translatedObj: any;
        try {
          translatedObj = JSON.parse(resultText);
        } catch (jsonErr) {
           // Fallback for slightly malformed JSON strings from LLMs
           console.warn(`[Translate] JSON parse error, attempting to sanitize: ${jsonErr}`);
           resultText = resultText.replace(/\\+"/g, '\\"').replace(/\\'+/g, "'"); 
           try { translatedObj = JSON.parse(resultText); } catch(e) { throw new Error("Unrecoverable JSON format"); }
        }

        if (typeof translatedObj === 'object' && !Array.isArray(translatedObj)) {
            const resultArr: string[] = [];
            for (let i = 0; i < texts.length; i++) {
                resultArr.push(translatedObj[`t${i}`] || texts[i]); // Guarantee identical length, fallback to original if missing
            }
            return resultArr;
        }
        throw new Error("Result is not a JSON Object");
      } catch (e: any) {
        if (e.name === 'AbortError' || e.message?.includes('AbortError')) throw e;
        console.warn(`[Translate] Attempt ${3-retries} failed:`, e.message);
        retries--;
        resultText = ""; // Clear for retry
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
            /word\/endnotes\.xml/,
            /word\/charts\/chart\d+\.xml/,
            /word\/diagrams\/data\d+\.xml/
          ], 
          textTag: 'w:t' // Fallback for standard docx elements. Note that charts use a:t or c:v but we focus on standard w:t/a:t first.
        };
      } else if (extension === '.xlsx') {
        formatConfig = { 
          xmlPaths: [
            /xl\/worksheets\/sheet\d+\.xml/,
            /xl\/sharedStrings\.xml/,
            /xl\/charts\/chart\d+\.xml/
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
            /ppt\/diagrams\/data\d+\.xml/,
            /ppt\/charts\/chart\d+\.xml/,
            /ppt\/slideMasters\/slideMaster\d+\.xml/,
            /ppt\/slideLayouts\/slideLayout\d+\.xml/,
            /ppt\/handoutMasters\/handoutMaster\d+\.xml/,
            /ppt\/notesMasters\/notesMaster\d+\.xml/
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

      // Process XML files in PARALLEL for maximum performance
      const XML_CONCURRENCY = 3;
      const XML_BATCH_SIZE = Math.ceil(xmlFiles.length / XML_CONCURRENCY);
      
      const processXmlFile = async (xmlPath: string) => {
        if (isClientDisconnected) return;
        const content = await zip.file(xmlPath)?.async('string');
        if (!content) return;

        const doc = new DOMParser().parseFromString(content, 'application/xml');
        const paragraphTag = (extension === '.docx') ? 'w:p' : (extension === '.pptx' ? 'a:p' : null);
        
        interface TextGroup {
          originalNodes: Element[];
          mergedText: string;
        }
        const groupsToTranslate: TextGroup[] = [];
        
        if (paragraphTag) {
          const paragraphs = Array.from(doc.getElementsByTagName(paragraphTag));
          
          // Also fetch isolated drawing/text elements not wrapped in standard paragraphs (common in charts/SmartArt)
          // Also look for fallback 't' tags which Excel/some SmartArts might use interchangeably
          const isolatedNodes = Array.from(doc.getElementsByTagName('a:t'));
          if (formatConfig.textTag !== 'a:t') {
             isolatedNodes.push(...Array.from(doc.getElementsByTagName(formatConfig.textTag)));
          }
          const filteredIsolatedNodes = isolatedNodes.filter(
            n => !n.closest || !n.closest(paragraphTag) // For standard DOM parsers that support closest
          );
          
          paragraphs.forEach(p => {
            const localGroups: TextGroup[] = [];
            let currentNodes: Element[] = [];

            // Traverse the paragraph and break merge groups at line breaks (a:br / w:br)
            const traverse = (node: Node) => {
              if (node.nodeName === 'a:br' || node.nodeName === 'w:br') {
                 if (currentNodes.length > 0) {
                    localGroups.push({ originalNodes: currentNodes, mergedText: currentNodes.map(n => n.textContent || "").join("") });
                    currentNodes = [];
                 }
              } else if (node.nodeName === formatConfig.textTag) {
                 currentNodes.push(node as Element);
              } else if (node.childNodes) {
                 for (let i = 0; i < node.childNodes.length; i++) traverse(node.childNodes[i]);
              }
            };

            traverse(p);
            if (currentNodes.length > 0) {
              localGroups.push({ originalNodes: currentNodes, mergedText: currentNodes.map(n => n.textContent || "").join("") });
            }

            localGroups.forEach(lg => {
              const trimmedText = lg.mergedText.trim();
              if (trimmedText.length > 0 && /[a-zA-Z\u4e00-\u9fa5\d]/.test(trimmedText) && !/^[\d\s.,?!]+$/.test(trimmedText)) {
                const cached = GLOBAL_TRANSLATION_CACHE.get(lg.mergedText);
                if (cached) {
                  lg.originalNodes[0].textContent = cached;
                  for (let j = 1; j < lg.originalNodes.length; j++) lg.originalNodes[j].textContent = "";
                  totalNodesSkipped += lg.originalNodes.length;
                } else {
                  groupsToTranslate.push(lg);
                }
              } else {
                totalNodesSkipped += lg.originalNodes.length;
              }
            });
          });
          
          // Process isolated text nodes that might belong to diagrams/charts mapped as a:t
          filteredIsolatedNodes.forEach(node => {
            const text = (node.textContent || "").trim();
            if (text.length > 0 && /[a-zA-Z\u4e00-\u9fa5\d]/.test(text) && !/^[\d\s.,?!]+$/.test(text)) {
              const cached = GLOBAL_TRANSLATION_CACHE.get(text);
              if (cached) {
                node.textContent = cached;
                totalNodesSkipped++;
              } else {
                groupsToTranslate.push({ originalNodes: [node], mergedText: text });
              }
            } else {
              totalNodesSkipped++;
            }
          });
        } else {
          const tNodes = Array.from(doc.getElementsByTagName(formatConfig.textTag));
          
          // Enhanced: Also scrape for 'a:t' in docx/xlsx because DrawingML/Charts often use 'a:t' universally for text elements.
          if (formatConfig.textTag !== 'a:t') {
             const drawingNodes = Array.from(doc.getElementsByTagName('a:t'));
             tNodes.push(...drawingNodes);
          }

          tNodes.forEach(node => {
            const text = (node.textContent || "").trim();
            // Loosened regex identically for fallback nodes
            if (text.length > 0 && /[a-zA-Z\u4e00-\u9fa5\d]/.test(text) && !/^[\d\s.,?!]+$/.test(text)) {
              const cached = GLOBAL_TRANSLATION_CACHE.get(text);
              if (cached) {
                node.textContent = cached;
                totalNodesSkipped++;
              } else {
                groupsToTranslate.push({ originalNodes: [node], mergedText: text });
              }
            } else {
              totalNodesSkipped++;
            }
          });
        }

        if (groupsToTranslate.length === 0) {
          zip.file(xmlPath, new XMLSerializer().serializeToString(doc));
          return;
        }

        const batches: TextGroup[][] = [];
        let currentBatch: TextGroup[] = [];
        let currentChars = 0;
        const MAX_CHARS = 1200; 
        const MAX_ITEMS = 10;

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

        // Batch processing with internal concurrency
        for (let i = 0; i < batches.length; i += CONCURRENCY_LIMIT) {
          if (isClientDisconnected) break;
          const currentChunks = batches.slice(i, i + CONCURRENCY_LIMIT);
          await Promise.all(currentChunks.map(async (batch) => {
            try {
              const translated = await internalTranslate(
                batch.map(g => g.mergedText), 
                target_lang || 'Chinese', 
                finalApiKey, provider_id, providerConfig, finalModel,
                abortController.signal
              );
              batch.forEach((group, idx) => {
                const trans = translated[idx];
                if (trans && trans !== group.mergedText) {
                  group.originalNodes[0].textContent = trans;
                  for (let k = 1; k < group.originalNodes.length; k++) group.originalNodes[k].textContent = "";
                  addToGlobalCache(group.mergedText, trans);
                }
                totalNodesTranslated += group.originalNodes.length;
              });
            } catch (err: any) {
              if (err.name === 'AbortError' || err.message?.includes('AbortError')) throw err;
              console.warn(`[Batch] Error processing batch in ${xmlPath}`);
            }
          }));
        }
        zip.file(xmlPath, new XMLSerializer().serializeToString(doc));
      };

      // Run parallel XML processing in groups
      for (let i = 0; i < xmlFiles.length; i += XML_CONCURRENCY) {
          if (isClientDisconnected) break;
          const slice = xmlFiles.slice(i, i + XML_CONCURRENCY);
          console.log(`[Dify] Parallel processing XML files: ${slice.join(', ')}`);
          await Promise.all(slice.map(path => processXmlFile(path)));
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
