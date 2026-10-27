import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';

export interface PickedFile { name: string; mime: string; base64: string }
const LIMIT = 5 * 1024 * 1024;
async function read(uri: string, name: string, mime: string): Promise<PickedFile> {
  const file = new File(uri);
  if (!file.size || file.size > LIMIT) throw new Error(`${name} is too large. Choose files up to 5 MB.`);
  return { name: name.replace(/[\\/\u0000-\u001f]/g, '-').slice(0, 160) || 'attachment', mime, base64: await file.base64() };
}
async function image(uri: string, width: number, height: number, name?: string): Promise<PickedFile> {
  const context = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > 2048) context.resize(width >= height ? { width: 2048 } : { height: 2048 });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return read(saved.uri, `${(name || 'photo').replace(/\.[^.]+$/, '')}.jpg`, 'image/jpeg');
}
export async function pickMedia(kind: 'library' | 'camera' | 'files'): Promise<PickedFile[]> {
  if (kind === 'files') {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return [];
    if (result.assets.length > 10) throw new Error('Choose up to 10 attachments.');
    return Promise.all(result.assets.map(asset => read(asset.uri, asset.name, asset.mimeType || 'application/octet-stream')));
  }
  if (kind === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Allow camera access in your phone settings to take a photo.');
  }
  const result = kind === 'camera' ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: 10, quality: 0.85 });
  if (result.canceled) return [];
  return Promise.all(result.assets.map((asset, index) => asset.type === 'video'
    ? read(asset.uri, asset.fileName || `video-${index + 1}.mp4`, asset.mimeType || 'video/mp4')
    : image(asset.uri, asset.width, asset.height, asset.fileName || `photo-${index + 1}`)));
}
