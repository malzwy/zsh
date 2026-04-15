import React, { useState, useCallback, useEffect } from 'react';
import { UploadCloud, FileType, CheckCircle, AlertCircle, Download, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface FileFormatConfig {
  extensions: string[];
  xmlPaths: (path: string) => boolean;
  paragraphTag: string;
  textTag: string;
}

const FORMATS: FileFormatConfig[] = [
  {
    extensions: ['.docx'],
    xmlPaths: (path) => path.startsWith('word/') && path.endsWith('.xml'),
    paragraphTag: 'w:p',
    textTag: 'w:t'
  },
  {
    extensions: ['.pptx'],
    xmlPaths: (path) => path.startsWith('ppt/') && path.endsWith('.xml'),
    paragraphTag: 'a:p',
    textTag: 'a:t'
  },
  {
    extensions: ['.xlsx'],
    xmlPaths: (path) => path === 'xl/sharedStrings.xml',
    paragraphTag: 'si',
    textTag: 't'
  }
];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function translateTexts(
  texts: string[], 
  targetLanguage: string, 
  customApiKey: string,
  providerId: string,
  providerConfig: any,
  model: string,
  delayMs: number,
  onStatusUpdate?: (status: string) => void
): Promise<string[]> {
  if (texts.length === 0) return [];
  
  const apiKey = customApiKey || providerConfig.defaultKey || (providerId === 'gemini' ? process.env.GEMINI_API_KEY : '');
  if (!apiKey && providerId !== 'ollama') {
    throw new Error(`${providerConfig.name} API Key is required. Please enter it in the settings or configure it in config.json.`);
  }

  let retries = 3;

  while (retries >= 0) {
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts, targetLanguage, apiKey, providerId, providerConfig, model })
      });
      
      if (!res.ok) {
        const errData = await res.json();
        const error: any = new Error(errData.error || 'Translation failed');
        error.status = res.status;
        error.details = errData;
        throw error;
      }
      
      const data = await res.json();
      const translatedTexts = data.translatedTexts;
      
      if (onStatusUpdate) onStatusUpdate("Translating document...");
      await sleep(delayMs);
      
      return translatedTexts;
    } catch (error: any) {
      console.error("Translation error:", error);
      
      const isAuthError = error?.status === 401 || error?.status === 403 || error?.message?.toLowerCase().includes('api key');
      if (isAuthError) {
        throw new Error(`Authentication failed. Please check your ${providerConfig.name} API key.`);
      }

      const isRateLimit = error?.status === 429 || 
                          error?.status === 'RESOURCE_EXHAUSTED' ||
                          error?.message?.includes("429") || 
                          error?.message?.includes("quota") || 
                          error?.message?.includes("RESOURCE_EXHAUSTED") ||
                          error?.message?.includes("速率限制") ||
                          error?.message?.includes("频率");

      if (retries === 0) {
        if (isRateLimit) {
          throw new Error(`Rate limit exceeded: ${error?.message || 'Please check your plan and billing details.'}`);
        }
        throw new Error(`Translation failed: ${error?.message || 'Unknown error'}`);
      }
      
      if (isRateLimit) {
        const waitSeconds = 60;
        if (onStatusUpdate) onStatusUpdate(`Rate limit hit. Waiting ${waitSeconds} seconds to recover...`);
        console.log(`Rate limit hit. Waiting ${waitSeconds}s before retrying...`);
        await sleep(waitSeconds * 1000);
      } else {
        await sleep(2000);
      }
      
      retries--;
    }
  }
  return texts;
}

export default function App() {
  const [providersConfig, setProvidersConfig] = useState<Record<string, any> | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [targetLanguage, setTargetLanguage] = useState('Chinese');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [delaySeconds, setDelaySeconds] = useState(6);
  const [batchSize, setBatchSize] = useState(50);
  const [concurrency, setConcurrency] = useState(1);
  const [isTranslating, setIsTranslating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Translating document...');
  const [error, setError] = useState<string | null>(null);
  const [translatedFileUrl, setTranslatedFileUrl] = useState<string | null>(null);
  const [translatedFileName, setTranslatedFileName] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => {
        if (data && data.providers) {
          setProvidersConfig(data.providers);
          const firstProvider = Object.keys(data.providers)[0];
          if (firstProvider) {
            setProvider(firstProvider);
            setModel(data.providers[firstProvider].models[0].id);
          }
        }
      })
      .catch(err => console.error("Failed to load config:", err));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) validateAndSetFile(droppedFile);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) validateAndSetFile(selectedFile);
  };

  const validateAndSetFile = (selectedFile: File) => {
    const ext = selectedFile.name.substring(selectedFile.name.lastIndexOf('.')).toLowerCase();
    if (FORMATS.some(f => f.extensions.includes(ext))) {
      setFile(selectedFile);
      setError(null);
      setTranslatedFileUrl(null);
      setProgress(0);
    } else {
      setError("Unsupported file format. Please upload a .docx, .pptx, or .xlsx file.");
      setFile(null);
    }
  };

  const [processingMode, setProcessingMode] = useState<'server' | 'client'>('server');

  const handleTranslate = async () => {
    if (!file) return;

    setIsTranslating(true);
    setProgress(0);
    setStatus('Preparing document...');
    setError(null);
    setTranslatedFileUrl(null);

    try {
      if (processingMode === 'server') {
        setStatus('Uploading and translating on server (this may take a few minutes)...');
        const formData = new FormData();
        formData.append('file', file);
        formData.append('target_lang', targetLanguage);
        formData.append('provider_id', provider);
        formData.append('model_id', model);
        formData.append('api_key', apiKey);

        const response = await fetch('/api/v1/translate-doc', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || 'Server-side translation failed');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        const baseName = file.name.substring(0, file.name.lastIndexOf('.'));
        setTranslatedFileUrl(url);
        setTranslatedFileName(`${baseName}_${targetLanguage}${ext}`);
        setProgress(100);
      } else {
        // Client-side logic (existing)
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        const format = FORMATS.find(f => f.extensions.includes(ext));
        
        if (!format) {
          throw new Error("Unsupported file format.");
        }

        const zip = await JSZip.loadAsync(file);
        const xmlFilesToProcess: JSZip.JSZipObject[] = [];
        
        zip.forEach((relativePath, zipEntry) => {
          if (format.xmlPaths(relativePath)) {
            xmlFilesToProcess.push(zipEntry);
          }
        });

        let totalParagraphs = 0;
        let processedParagraphs = 0;

        const fileData: { file: JSZip.JSZipObject, doc: Document, paragraphs: Element[] }[] = [];
        const parser = new DOMParser();
        
        for (const xmlFile of xmlFilesToProcess) {
          const xmlString = await xmlFile.async("string");
          const doc = parser.parseFromString(xmlString, "application/xml");
          const paragraphs = Array.from(doc.getElementsByTagName(format.paragraphTag));
          
          const textParagraphs = paragraphs.filter(p => {
            const texts = Array.from(p.getElementsByTagName(format.textTag));
            return texts.some(t => t.textContent?.trim());
          });

          if (textParagraphs.length > 0) {
            fileData.push({ file: xmlFile, doc, paragraphs: textParagraphs });
            totalParagraphs += textParagraphs.length;
          }
        }

        if (totalParagraphs === 0) {
          throw new Error("No translatable text found in the document.");
        }

        const BATCH_SIZE = batchSize > 0 ? batchSize : 50;
        
        for (const data of fileData) {
          const { file: xmlFile, doc, paragraphs } = data;
          
          const batches = [];
          for (let i = 0; i < paragraphs.length; i += BATCH_SIZE) {
            batches.push(paragraphs.slice(i, i + BATCH_SIZE));
          }

          for (let i = 0; i < batches.length; i += concurrency) {
            const chunk = batches.slice(i, i + concurrency);
            
            await Promise.all(chunk.map(async (batch) => {
              const textsToTranslate = batch.map(p => {
                const tNodes = Array.from(p.getElementsByTagName(format.textTag));
                return tNodes.map((t: any) => t.textContent || "").join("");
              });

              const translatedTexts = await translateTexts(
                textsToTranslate, 
                targetLanguage, 
                apiKey, 
                provider, 
                providersConfig![provider],
                model, 
                delaySeconds * 1000,
                setStatus
              );

              batch.forEach((p, index) => {
                const translatedText = translatedTexts[index];
                const tNodes = Array.from(p.getElementsByTagName(format.textTag));
                
                if (tNodes.length > 0) {
                  (tNodes[0] as any).textContent = translatedText;
                  for (let j = 1; j < tNodes.length; j++) {
                    (tNodes[j] as any).textContent = "";
                  }
                }
              });
            }));

            processedParagraphs += chunk.reduce((acc, b) => acc + b.length, 0);
            setProgress(Math.round((processedParagraphs / totalParagraphs) * 100));
          }

          const serializer = new XMLSerializer();
          const newXmlString = serializer.serializeToString(doc);
          zip.file(xmlFile.name, newXmlString);
        }

        const newBlob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(newBlob);
        
        setTranslatedFileUrl(url);
        setTranslatedFileName(`translated_${file.name}`);
        setProgress(100);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "An error occurred during translation.");
    } finally {
      setIsTranslating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <Card className="w-full max-w-2xl shadow-lg border-slate-200">
        <CardHeader className="text-center space-y-2">
          <CardTitle className="text-3xl font-bold tracking-tight text-slate-900">
            Office Document Translator
          </CardTitle>
          <CardDescription className="text-slate-500 text-base">
            Translate Word, Excel, and PowerPoint files while preserving their original formatting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          
          {/* Upload Area */}
          {!file && !translatedFileUrl && (
            <div 
              className="border-2 border-dashed border-slate-300 rounded-xl p-12 text-center hover:bg-slate-100 transition-colors cursor-pointer group"
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-upload')?.click()}
            >
              <input 
                id="file-upload" 
                type="file" 
                className="hidden" 
                accept=".docx,.pptx,.xlsx"
                onChange={handleFileChange}
              />
              <div className="flex flex-col items-center space-y-4">
                <div className="p-4 bg-slate-100 rounded-full group-hover:bg-slate-200 transition-colors">
                  <UploadCloud className="w-8 h-8 text-slate-500" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">Click to upload or drag and drop</p>
                  <p className="text-xs text-slate-500 mt-1">Supports .docx, .pptx, .xlsx</p>
                </div>
              </div>
            </div>
          )}

          {/* File Selected State */}
          {file && !translatedFileUrl && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
              <div className="flex items-center space-x-4">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <FileType className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">{file.name}</p>
                  <p className="text-xs text-slate-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
              </div>
              {!isTranslating && (
                <Button variant="ghost" size="sm" onClick={() => setFile(null)} className="text-slate-500 hover:text-slate-700">
                  Remove
                </Button>
              )}
            </div>
          )}

          {/* Settings & Action */}
          {file && !translatedFileUrl && (
            <div className="space-y-4">
              {!providersConfig ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Processing Mode</Label>
                    <Select value={processingMode} onValueChange={(val: any) => setProcessingMode(val)}>
                      <SelectTrigger className="bg-white">
                        <SelectValue placeholder="Select mode" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="server">Server-side (Fast & Stable)</SelectItem>
                        <SelectItem value="client">Client-side (Progressive)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Provider</Label>
                    <Select value={provider} onValueChange={(val) => { setProvider(val); setModel(providersConfig[val].models[0].id); }}>
                      <SelectTrigger className="bg-white">
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(providersConfig).map(([key, config]: [string, any]) => (
                          <SelectItem key={key} value={key}>{config.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700">Model</Label>
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger className="bg-white">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent>
                        {provider && providersConfig[provider]?.models.map((m: any) => (
                          <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="language" className="text-sm font-medium text-slate-700">Target Language</Label>
                    <Input 
                      id="language" 
                      value={targetLanguage}
                      onChange={(e) => setTargetLanguage(e.target.value)}
                      placeholder="e.g. Chinese, Spanish, French"
                      disabled={isTranslating}
                      className="bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="delay" className="text-sm font-medium text-slate-700">Delay between requests (seconds)</Label>
                    <Input 
                      id="delay" 
                      type="number"
                      min="0"
                      step="0.5"
                      value={delaySeconds}
                      onChange={(e) => setDelaySeconds(parseFloat(e.target.value) || 0)}
                      disabled={isTranslating}
                      className="bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="batchSize" className="text-sm font-medium text-slate-700">Batch Size (paragraphs)</Label>
                    <Input 
                      id="batchSize" 
                      type="number"
                      min="1"
                      max="200"
                      step="1"
                      value={batchSize}
                      onChange={(e) => setBatchSize(parseInt(e.target.value) || 50)}
                      disabled={isTranslating}
                      className="bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="concurrency" className="text-sm font-medium text-slate-700">Concurrent Requests</Label>
                    <Input 
                      id="concurrency" 
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={concurrency}
                      onChange={(e) => setConcurrency(parseInt(e.target.value) || 1)}
                      disabled={isTranslating}
                      className="bg-white"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="apiKey" className="text-sm font-medium text-slate-700">
                      API Key {provider && providersConfig[provider]?.defaultKey ? '(Optional, uses config default if empty)' : '(Optional Override)'}
                    </Label>
                    <Input 
                      id="apiKey" 
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={`Enter your ${provider ? providersConfig[provider]?.name : ''} API key...`}
                      disabled={isTranslating}
                      className="bg-white"
                    />
                  </div>
                </div>
              )}

              {isTranslating ? (
                <div className="space-y-3 pt-4">
                  <div className="flex justify-between text-sm font-medium text-slate-700">
                    <span>{status}</span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} className="h-2" />
                </div>
              ) : (
                <Button 
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-6 text-lg rounded-xl transition-all shadow-sm hover:shadow-md"
                  onClick={handleTranslate}
                >
                  Translate Document
                </Button>
              )}
            </div>
          )}

          {/* Error State */}
          {error && (
            <Alert variant="destructive" className="bg-red-50 border-red-200 text-red-800">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Success State */}
          {translatedFileUrl && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-8 text-center space-y-6">
              <div className="flex justify-center">
                <div className="p-3 bg-green-100 rounded-full">
                  <CheckCircle className="w-10 h-10 text-green-600" />
                </div>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-green-900">Translation Complete!</h3>
                <p className="text-sm text-green-700 mt-1">Your document has been translated successfully.</p>
              </div>
              <div className="flex flex-col space-y-3">
                <Button 
                  asChild
                  className="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-6 text-lg rounded-xl transition-all shadow-sm hover:shadow-md"
                >
                  <a href={translatedFileUrl} download={translatedFileName || 'translated_document'}>
                    <Download className="w-5 h-5 mr-2" />
                    Download Translated File
                  </a>
                </Button>
                <Button 
                  variant="outline" 
                  className="w-full py-6 text-slate-700 border-slate-300 hover:bg-slate-100"
                  onClick={() => {
                    setFile(null);
                    setTranslatedFileUrl(null);
                    setProgress(0);
                  }}
                >
                  Translate Another File
                </Button>
              </div>
            </div>
          )}

        </CardContent>
      </Card>
    </div>
  );
}

