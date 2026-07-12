import React from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const work = [
  ['Teaching schedule', 'Secure sign-in required to load assigned sessions'],
  ['Attendance pending', 'No roster data cached on this device'],
  ['Approvals', 'Sign in with required assurance to open your inbox'],
  ['Student follow-ups', 'Restricted notes are never placed in notification payloads'],
];
function App(): React.JSX.Element {
  const dark = useColorScheme() === 'dark';
  return <SafeAreaProvider><StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
    <SafeAreaView style={[styles.safe, dark && styles.safeDark]}><ScrollView contentContainerStyle={styles.content}>
      <View accessibilityRole="header" style={styles.brand}><View style={styles.mark} accessibilityElementsHidden />
        <View><Text style={[styles.eyebrow, dark && styles.mutedDark]}>NIET GREATER NOIDA</Text>
          <Text style={[styles.title, dark && styles.textDark]}>Staff</Text></View></View>
      <Text accessibilityRole="header" style={[styles.heading, dark && styles.textDark]}>Operational work</Text>
      <Text style={[styles.summary, dark && styles.mutedDark]}>Fast, scoped access for faculty and staff. High-risk administrative operations remain web-only.</Text>
      <View style={styles.list}>{work.map(([label, value]) => <View key={label} style={[styles.row, dark && styles.rowDark]}>
        <Text style={[styles.label, dark && styles.textDark]}>{label}</Text><Text style={[styles.value, dark && styles.mutedDark]}>{value}</Text>
      </View>)}</View>
      <View accessibilityRole="alert" style={styles.notice}><Text style={styles.noticeTitle}>Preview foundation</Text>
        <Text style={styles.noticeText}>Identity, biometric unlock, encrypted offline storage, and production API access remain disabled until the relevant NIET policies are approved.</Text></View>
    </ScrollView></SafeAreaView></SafeAreaProvider>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' }, safeDark: { backgroundColor: '#111111' }, content: { padding: 20, gap: 18 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12 }, mark: { width: 8, height: 44, backgroundColor: '#E5323A' },
  eyebrow: { color: '#666666', fontSize: 12, fontWeight: '700', letterSpacing: 1 }, title: { color: '#222222', fontSize: 24, fontWeight: '800' },
  heading: { color: '#222222', fontSize: 22, fontWeight: '800', marginTop: 8 }, summary: { color: '#666666', fontSize: 16, lineHeight: 23 },
  list: { borderWidth: 1, borderColor: '#D8D8D8', backgroundColor: '#FFFFFF' }, row: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#D8D8D8', gap: 5 },
  rowDark: { backgroundColor: '#222222', borderBottomColor: '#444444' }, label: { color: '#222222', fontSize: 16, fontWeight: '700' },
  value: { color: '#666666', fontSize: 14, lineHeight: 20 }, notice: { borderLeftWidth: 4, borderLeftColor: '#E5323A', backgroundColor: '#FFF1F1', padding: 14, gap: 4 },
  noticeTitle: { color: '#7A1420', fontSize: 15, fontWeight: '800' }, noticeText: { color: '#7A1420', lineHeight: 20 },
  textDark: { color: '#FFFFFF' }, mutedDark: { color: '#C7C7C7' },
});
export default App;
