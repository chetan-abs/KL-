import 'react-native-gesture-handler';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import {
  PlusJakartaSans_300Light,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';

import { COLORS } from './constants/colors';
import AlertHost from './components/AlertHost';
import { AuthProvider } from './context/AuthContext';
import MobileNavigator from './navigation/MobileNavigator';

export default function App() {
  // TYPOGRAPHY maps weights onto these four aliases, so every AppText resolves
  // through here. Nothing renders until they load or fail.
  const [fontsLoaded, fontError] = useFonts({
    'AppFont-Light': PlusJakartaSans_300Light,
    'AppFont-Regular': PlusJakartaSans_400Regular,
    'AppFont-Medium': PlusJakartaSans_500Medium,
    'AppFont-Bold': PlusJakartaSans_700Bold,
  });

  if (!fontsLoaded && !fontError) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaProvider>
        {/* Light content: every screen opens on the navy header, and dark glyphs
            on that band are unreadable. */}
        <StatusBar style="light" />
        <AuthProvider>
          <MobileNavigator />
        </AuthProvider>
        {/* Mounted once at the root so showAlert()/confirmAction() can be called
            from services and interceptors that sit outside the React tree. */}
        <AlertHost />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    padding: 24,
  },
});
