import React from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const tasks = [
  { label: 'Today', value: 'Secure sign-in required to load your timeline' },
  { label: 'Next class', value: 'No schedule cached on this device' },
  { label: 'Attendance', value: 'Sign in to view verified attendance evidence' },
  { label: 'Fees and holds', value: 'Sign in to view your current account status' },
];

function App(): React.JSX.Element {
  const dark = useColorScheme() === 'dark';
  return <SafeAreaProvider><StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
    <SafeAreaView style={[styles.safe, dark && styles.safeDark]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View accessibilityRole="header" style={styles.brand}>
          <View style={styles.mark} accessibilityElementsHidden />
          <View><Text style={[styles.eyebrow, dark && styles.mutedDark]}>NIET GREATER NOIDA</Text>
            <Text style={[styles.title, dark && styles.textDark]}>Student</Text></View>
        </View>
        <Text accessibilityRole="header" style={[styles.heading, dark && styles.textDark]}>What needs your attention</Text>
        <Text style={[styles.summary, dark && styles.mutedDark]}>
          Institutional data is retrieved after secure NIET authentication and is not stored here in plaintext.
        </Text>
        <View style={styles.list}>{tasks.map((task) => <View key={task.label} style={[styles.row, dark && styles.rowDark]}>
          <Text style={[styles.label, dark && styles.textDark]}>{task.label}</Text>
          <Text style={[styles.value, dark && styles.mutedDark]}>{task.value}</Text>
        </View>)}</View>
        <View accessibilityRole="alert" style={styles.notice}>
          <Text style={styles.noticeTitle}>Preview foundation</Text>
          <Text style={styles.noticeText}>Authentication and production data access stay disabled until NIET identity, mobile security, and push policy decisions are approved.</Text>
        </View>
      </ScrollView>
    </SafeAreaView></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' }, safeDark: { backgroundColor: '#111111' },
  content: { padding: 20, gap: 18 }, brand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  mark: { width: 8, height: 44, backgroundColor: '#E5323A' }, eyebrow: { color: '#666666', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  title: { color: '#222222', fontSize: 24, fontWeight: '800' }, heading: { color: '#222222', fontSize: 22, fontWeight: '800', marginTop: 8 },
  summary: { color: '#666666', fontSize: 16, lineHeight: 23 }, list: { borderWidth: 1, borderColor: '#D8D8D8', backgroundColor: '#FFFFFF' },
  row: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#D8D8D8', gap: 5 }, rowDark: { backgroundColor: '#222222', borderBottomColor: '#444444' },
  label: { color: '#222222', fontSize: 16, fontWeight: '700' }, value: { color: '#666666', fontSize: 14, lineHeight: 20 },
  notice: { borderLeftWidth: 4, borderLeftColor: '#E5323A', backgroundColor: '#FFF1F1', padding: 14, gap: 4 },
  noticeTitle: { color: '#7A1420', fontSize: 15, fontWeight: '800' }, noticeText: { color: '#7A1420', lineHeight: 20 },
  textDark: { color: '#FFFFFF' }, mutedDark: { color: '#C7C7C7' },
});
export default App;
