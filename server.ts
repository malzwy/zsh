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

  app.use(express.json({ limit: '50mb' }));

  // Helper for batch translation (internal use)
  async function internalTranslate(texts: string[], targetLanguage: string, apiKey: string, providerId: string, providerConfig: any, model: string) {
    if (texts.length === 0) return [];
    
    const prompt = `Translate the following JSON array of strings to ${targetLanguage}. 
Return ONLY a valid JSON array of strings in the exact same order, with the exact same number of elements. 
Do not include any markdown formatting like \`\`\`json. Just the raw JSON array.

Strings to translate:
${JSON.stringify(texts)}`;

    let resultText = "";
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
      });
      resultText = response.choices[0]?.message?.content?.trim() || "[]";
    }

    resultText = resultText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    resultText = resultText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const match = resultText.match(/\[\s*[\s\S]*\s*\]/);
    if (match) resultText = match[0];

    const translated = JSON.parse(resultText);
    if (!Array.isArray(translated) || translated.length !== texts.length) {
      throw new Error("Translation format error");
    }
    return translated;
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

  // Dify-compatible Document Translation API (Optimized for Sync Response)
  app.post('/api/v1/translate-doc', upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      const { target_lang, provider_id, model_id, api_key } = req.body;

      if (!file) return res.status(400).json({ error: "No file uploaded" });
      
      const configPath = path.join(__dirname, 'config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      const providerConfig = config.providers[provider_id || 'gemini'];
      const finalApiKey = api_key || providerConfig.defaultKey;
      const finalModel = model_id || providerConfig.models[0].id;

      const zip = await JSZip.loadAsync(file.buffer);
      const extension = path.extname(file.originalname).toLowerCase();
      
      let formatConfig = {
        xmlPaths: [/word\/document\.xml/],
        textTag: 'w:t'
      };

      if (extension === '.xlsx') {
        formatConfig = { xmlPaths: [/xl\/worksheets\/sheet\d+\.xml/], textTag: 't' };
      } else if (extension === '.pptx') {
        formatConfig = { xmlPaths: [/ppt\/slides\/slide\d+\.xml/], textTag: 'a:t' };
      }

      const xmlFiles = Object.keys(zip.files).filter(name => 
        formatConfig.xmlPaths.some(regex => regex.test(name))
      );

      // Process files
      for (const xmlPath of xmlFiles) {
        const content = await zip.file(xmlPath)?.async('string');
        if (!content) continue;

        const doc = new DOMParser().parseFromString(content, 'application/xml');
        const tNodes = Array.from(doc.getElementsByTagName(formatConfig.textTag));
        
        // Dify Optimization: Use larger batches (50) to stay within 60s timeout
        const BATCH_SIZE = 50;
        for (let i = 0; i < tNodes.length; i += BATCH_SIZE) {
          const batch = tNodes.slice(i, i + BATCH_SIZE);
          const texts = batch.map(n => n.textContent || "").filter(t => t.trim().length > 0);
          
          if (texts.length > 0) {
            const translated = await internalTranslate(
              texts, 
              target_lang || 'Chinese', 
              finalApiKey, 
              provider_id || 'gemini', 
              providerConfig, 
              finalModel
            );

            let translatedIdx = 0;
            batch.forEach((node) => {
              if ((node.textContent || "").trim().length > 0) {
                node.textContent = translated[translatedIdx++];
              }
            });
          }
        }

        const serializer = new XMLSerializer();
        zip.file(xmlPath, serializer.serializeToString(doc));
      }

      const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      
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
      res.status(500).json({ error: error.message });
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

      const prompt = `Translate the following JSON array of strings to ${targetLanguage}. 
Return ONLY a valid JSON array of strings in the exact same order, with the exact same number of elements. 
Do not include any markdown formatting like \`\`\`json. Just the raw JSON array.

Strings to translate:
${JSON.stringify(texts)}`;

      let resultText = "";

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
        });
        resultText = response.choices[0]?.message?.content?.trim() || "[]";
      }

      // Robust JSON extraction (handles <think> tags and markdown)
      resultText = resultText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      resultText = resultText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      const match = resultText.match(/\[\s*[\s\S]*\s*\]/);
      if (match) {
        resultText = match[0];
      }

      const translatedTexts = JSON.parse(resultText);
      
      if (!Array.isArray(translatedTexts) || translatedTexts.length !== texts.length) {
        throw new Error("Invalid response format or length mismatch");
      }

      res.json({ translatedTexts });
    } catch (error: any) {
      console.error("Backend Translation error:", error);
      res.status(500).json({ 
        error: error.message, 
        status: error.status || 500,
        details: error.response?.data || error
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
