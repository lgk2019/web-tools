import { Routes, Route } from 'react-router-dom';
import Layout from './components/layout/Layout';
import Home from './pages/Home';
import Category from './pages/Category';
import NotFound from './pages/NotFound';
import ImageCompress from './pages/tools/ImageCompress';
import ImageCrop from './pages/tools/ImageCrop';
import QRGenerator from './pages/tools/QRGenerator';
import ImageConvert from './pages/tools/ImageConvert';
import PDFEditor from './pages/tools/PDFEditor';
import JsonFormatter from './pages/tools/JsonFormatter';
import Base64Tool from './pages/tools/Base64Tool';
import QRReader from './pages/tools/QRReader';
import PDFToImage from './pages/tools/PDFToImage';
import WatermarkRemover from './pages/tools/WatermarkRemover';
import PasswordGenerator from './pages/tools/PasswordGenerator';
import UuidGenerator from './pages/tools/UuidGenerator';
import HashGenerator from './pages/tools/HashGenerator';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/category/:type" element={<Category />} />
        <Route path="/tool/image-compress" element={<ImageCompress />} />
        <Route path="/tool/image-crop" element={<ImageCrop />} />
        <Route path="/tool/qr-generator" element={<QRGenerator />} />
        <Route path="/tool/image-convert" element={<ImageConvert />} />
        <Route path="/tool/pdf-editor" element={<PDFEditor />} />
        <Route path="/tool/json-formatter" element={<JsonFormatter />} />
        <Route path="/tool/base64" element={<Base64Tool />} />
        <Route path="/tool/qr-reader" element={<QRReader />} />
        <Route path="/tool/pdf-to-image" element={<PDFToImage />} />
        <Route path="/tool/watermark-remover" element={<WatermarkRemover />} />
        <Route path="/tool/password-generator" element={<PasswordGenerator />} />
        <Route path="/tool/uuid-generator" element={<UuidGenerator />} />
        <Route path="/tool/hash-generator" element={<HashGenerator />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}
