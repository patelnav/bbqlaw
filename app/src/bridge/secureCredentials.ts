import * as SecureStore from 'expo-secure-store';
import { parseCredentials, type CredentialStore } from './credentials';

const KEY = 'credentials';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'app.bbqlaw.ios.bridge',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export const secureCredentials: CredentialStore = {
  load: async () => {
    try {
      return parseCredentials(await SecureStore.getItemAsync(KEY, OPTIONS));
    } catch (error) {
      console.warn('keychain:', error);
      return null;
    }
  },
  save: async (credentials) => {
    try {
      await SecureStore.setItemAsync(KEY, JSON.stringify(credentials), OPTIONS);
      return true;
    } catch (error) {
      console.warn('keychain:', error);
      return false;
    }
  },
  clear: async () => {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  },
};
