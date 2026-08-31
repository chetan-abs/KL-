import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { Attachments } from '../services/endpoints';

/**
 * Taking a delivery photo and getting it to the server.
 *
 * Delivery proof is a photograph (R06) — there is deliberately no party
 * signature — so this is the path that makes a delivery closable at all.
 *
 * A failed capture throws with something a driver can act on, in the same spirit
 * as `utils/location.js`: the old GPS helper answered a failed fix with Mumbai's
 * coordinates, and a picker that quietly returned nothing would be the same
 * mistake — a stop that will not close and no reason given.
 */

/** Requested at the moment of use, never at launch. */
async function ensureCameraPermission() {
  const { status, canAskAgain } = await ImagePicker.requestCameraPermissionsAsync();
  if (status === 'granted') return;

  throw new Error(
    canAskAgain
      ? 'Camera permission is needed to photograph the delivery.'
      : 'Camera permission is blocked. Enable it for this app in Settings.'
  );
}

/**
 * Opens the camera and returns the asset, base64 included.
 *
 * Compressed hard and capped in dimension: this is evidence a dispute is settled
 * with, not a photograph anybody frames, and a 12 MP original is four seconds of
 * upload on a shop-front connection for no added proof. `base64` is requested
 * because that is what the attachments route takes.
 */
export async function capturePhoto({ allowLibrary = false } = {}) {
  // The web build has no camera module worth using here; the file picker is what
  // a browser can actually offer, and saying so beats a permission error.
  if (Platform.OS === 'web' || allowLibrary) {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.5,
      allowsEditing: false,
    });
    if (result.canceled) return null;
    return result.assets?.[0] || null;
  }

  await ensureCameraPermission();

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    base64: true,
    quality: 0.5,
    allowsEditing: false,
    exif: false,
  });

  if (result.canceled) return null;
  return result.assets?.[0] || null;
}

/**
 * Captures and uploads in one step, returning the reference a delivery stores.
 *
 * Returns null when the user backed out of the camera — a cancel is not a
 * failure and must not raise an error at the caller.
 */
export async function captureAndUpload({ refType, refId, allowLibrary } = {}) {
  const asset = await capturePhoto({ allowLibrary });
  if (!asset) return null;

  if (!asset.base64) {
    throw new Error('The photo came back empty. Try taking it again.');
  }

  const { photo_ref } = await Attachments.upload({
    base64: asset.base64,
    mimeType: asset.mimeType || 'image/jpeg',
    name: asset.fileName || 'photo.jpg',
    refType,
    refId,
  });

  return photo_ref;
}

/**
 * The same capture-and-upload, but returns the attachment's numeric id rather
 * than `photo_ref`.
 *
 * Attendance (R-24) is checked against `attachments.id` — `routes/attendance.js`
 * looks the id up and confirms the caller uploaded it themselves — where a
 * delivery is checked against `photo_ref`. Two different id spaces for the same
 * upload, so this is a second export rather than a second meaning for
 * `captureAndUpload`'s return value.
 */
export async function captureAndUploadId({ refType, refId, allowLibrary } = {}) {
  const asset = await capturePhoto({ allowLibrary });
  if (!asset) return null;

  if (!asset.base64) {
    throw new Error('The photo came back empty. Try taking it again.');
  }

  const { attachment_id } = await Attachments.upload({
    base64: asset.base64,
    mimeType: asset.mimeType || 'image/jpeg',
    name: asset.fileName || 'photo.jpg',
    refType,
    refId,
  });

  return attachment_id;
}
