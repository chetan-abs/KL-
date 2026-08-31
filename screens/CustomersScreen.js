import React from 'react';
import {
  View,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  StyleSheet,
  ActivityIndicator,
  Linking
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AppText from '../components/AppText';
import Button from '../components/Button';
import Notice from '../components/Notice';
import { COLORS } from '../constants/colors';
import api, { describeError } from '../services/api';
import { showAlert } from '../services/confirm';
import { getCurrentLocation, requestLocationPermissions } from '../utils/location';
import { useAuth } from '../context/AuthContext';
import { userCan } from '../utils/permissions';

export default function CustomersScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const canCreate = userCan(user, 'customers.create');

  const [loading, setLoading] = React.useState(true);
  const [customers, setCustomers] = React.useState([]);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [selectedGroup, setSelectedGroup] = React.useState('All');
  const [error, setError] = React.useState('');
  
  // Onboard Customer Modal
  const [onboardModalVisible, setOnboardModalVisible] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Customer Form state
  const [form, setForm] = React.useState({
    name: '',
    person_name: '',
    phone: '',
    phone2: '',
    email: '',
    address: '',
    city: 'Guwahati',
    state: 'Assam',
    pincode: '',
    gst_number: '',
    pan_number: '',
    category: 'Retailer',
    credit_limit: '0',
    group_name: 'General',
    latitude: '',
    longitude: ''
  });

  const loadCustomers = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/customers');
      setCustomers(res.data.customers || []);
      setError('');
    } catch (err) {
      setError(describeError(err));
      setCustomers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  /**
   * Captures the shop's coordinates.
   *
   * Through expo-location rather than navigator.geolocation, which exists only
   * in a browser — on a device this threw. And a refused or failed fix is now
   * reported: it used to fill the form in with Mumbai's coordinates and
   * announce "GPS Captured", which pinned the shop 2,600 km from Guwahati.
   */
  const handleCaptureGps = async () => {
    try {
      const permission = await requestLocationPermissions();
      if (!permission.granted) {
        showAlert('Permission needed', 'Location permission is required to capture the shop position.');
        return;
      }
      const coords = await getCurrentLocation();
      setForm((prev) => ({
        ...prev,
        latitude: coords.latitude.toFixed(6),
        longitude: coords.longitude.toFixed(6)
      }));
      showAlert('GPS captured', `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`);
    } catch (err) {
      showAlert('No GPS fix', 'Could not read the current position. Move somewhere with a clearer view of the sky, or type the coordinates in.');
    }
  };

  // Submit Customer Onboarding
  const handleOnboardCustomer = async () => {
    if (!form.name.trim()) {
      showAlert('Missing details', 'Enter the shop or party name.');
      return;
    }
    if (!form.phone.trim()) {
      showAlert('Missing details', 'Enter a phone number.');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        ...form,
        credit_limit: parseFloat(form.credit_limit) || 0,
        latitude: form.latitude ? parseFloat(form.latitude) : null,
        longitude: form.longitude ? parseFloat(form.longitude) : null
      };

      const res = await api.post('/customers', payload);
      showAlert('Onboarded', res.data.message || 'Customer onboarded successfully.');
      
      setOnboardModalVisible(false);
      setForm({
        name: '', person_name: '', phone: '', phone2: '', email: '',
        address: '', city: 'Guwahati', state: 'Assam', pincode: '',
        gst_number: '', pan_number: '', category: 'Retailer',
        credit_limit: '0', group_name: 'General',
        latitude: '', longitude: ''
      });

      loadCustomers();
    } catch (err) {
      showAlert('Could not onboard customer', describeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Customer groups. Not "beats" — that concept was deliberately dropped, and
  // the column is group_name.
  const groups = ['All', ...new Set(customers.map((c) => c.group_name || 'General'))];

  // Filter customers
  const filteredCustomers = customers.filter((c) => {
    const matchesGroup = selectedGroup === 'All' || c.group_name === selectedGroup;
    if (!matchesGroup) return false;

    if (!searchQuery) return true;
    const term = searchQuery.toLowerCase();
    return (
      c.name.toLowerCase().includes(term) ||
      (c.person_name && c.person_name.toLowerCase().includes(term)) ||
      (c.phone && c.phone.includes(term)) ||
      (c.gst_number && c.gst_number.toLowerCase().includes(term)) ||
      (c.city && c.city.toLowerCase().includes(term))
    );
  });

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <AppText weight="bold" size="lg" color={COLORS.text}>
            Customer Directory & Onboarding
          </AppText>
          <AppText size="xs" color={COLORS.textSecondary}>
            Customer master, credit limits and shop onboarding
          </AppText>
        </View>

        {canCreate ? (
          <TouchableOpacity
            style={styles.onboardBtn}
            onPress={() => setOnboardModalVisible(true)}
          >
            <AppText size="xs" weight="bold" color={COLORS.textOnPrimary}>
              + Onboard Shop
            </AppText>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Filter & Search Bar */}
      <View style={styles.filterSection}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search customer, owner, phone, GST, city..."
          placeholderTextColor={COLORS.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupScroll}>
          {groups.map((g) => (
            <TouchableOpacity
              key={g}
              style={[styles.groupChip, selectedGroup === g && styles.groupChipActive]}
              onPress={() => setSelectedGroup(g)}
            >
              <AppText
                size="xs"
                weight="bold"
                color={selectedGroup === g ? COLORS.primary : COLORS.textSecondary}
              >
                {g}
              </AppText>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {error ? (
        <Notice tone="error" style={styles.loadError}>{error}</Notice>
      ) : null}

      {loading ? (
        <View style={styles.loaderCenter}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {filteredCustomers.map((cust) => (
            <View key={cust.masterid} style={styles.customerCard}>
              <View style={styles.cardHeader}>
                <View style={styles.flex}>
                  <View style={styles.tagRow}>
                    <View style={styles.catBadge}>
                      <AppText size="xs" weight="bold" color={COLORS.secondary}>
                        {cust.category || 'Retailer'}
                      </AppText>
                    </View>
                    <AppText size="xs" color={COLORS.textMuted}>
                      {cust.group_name || 'General'}
                    </AppText>
                  </View>
                  <AppText weight="bold" size="md" color={COLORS.text} style={styles.custName}>
                    {cust.name}
                  </AppText>
                  <AppText size="xs" color={COLORS.textSecondary}>
                    👤 Contact: {cust.person_name || 'Owner'} • 📞 {cust.phone || 'N/A'}
                  </AppText>
                </View>

                {/* Closing Balance Pill */}
                <View style={styles.balanceBox}>
                  <AppText size="xs" color={COLORS.textMuted}>Outstanding:</AppText>
                  <AppText
                    weight="bold"
                    size="sm"
                    color={cust.closing_balance > 0 ? COLORS.warning : COLORS.success}
                  >
                    ₹{parseFloat(cust.closing_balance || 0).toFixed(2)}
                  </AppText>
                </View>
              </View>

              <View style={styles.cardBody}>
                <AppText size="xs" color={COLORS.textMuted}>
                  📍 {cust.address || 'Address N/A'}, {cust.city || '—'}
                </AppText>
                {cust.gst_number ? (
                  <AppText size="xs" color={COLORS.textMuted}>
                    GSTIN: {cust.gst_number}
                  </AppText>
                ) : null}
              </View>

              <View style={styles.cardFooter}>
                <AppText size="xs" color={COLORS.textSecondary}>
                  Credit Limit: ₹{parseFloat(cust.credit_limit || 0).toLocaleString()}
                </AppText>

                {cust.phone ? (
                  <TouchableOpacity
                    style={styles.callBtn}
                    onPress={() => Linking.openURL(`tel:${cust.phone}`)}
                  >
                    <AppText size="xs" weight="bold" color={COLORS.primary}>
                      📞 Call Shop
                    </AppText>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Onboard Customer Modal */}
      <Modal visible={onboardModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <AppText weight="bold" size="lg" color={COLORS.text} style={styles.modalTitle}>
              Onboard New Customer / Shop
            </AppText>

            <ScrollView style={styles.modalForm}>
              <AppText size="xs" color={COLORS.textMuted} style={styles.label}>Shop / Party Name *</AppText>
              <TextInput
                style={styles.input}
                placeholder="e.g. Balaji Electric & Hardware"
                placeholderTextColor={COLORS.textMuted}
                value={form.name}
                onChangeText={(text) => setForm({ ...form, name: text })}
              />

              <AppText size="xs" color={COLORS.textMuted} style={styles.label}>Contact Person *</AppText>
              <TextInput
                style={styles.input}
                placeholder="Owner / Manager name"
                placeholderTextColor={COLORS.textMuted}
                value={form.person_name}
                onChangeText={(text) => setForm({ ...form, person_name: text })}
              />

              <View style={styles.row}>
                <View style={styles.flex}>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.label}>Phone Number *</AppText>
                  <TextInput
                    style={styles.input}
                    placeholder="10-digit mobile"
                    keyboardType="phone-pad"
                    placeholderTextColor={COLORS.textMuted}
                    value={form.phone}
                    onChangeText={(text) => setForm({ ...form, phone: text })}
                  />
                </View>

                <View style={styles.flex}>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.label}>Category</AppText>
                  <TextInput
                    style={styles.input}
                    placeholder="Retailer / Wholesaler"
                    placeholderTextColor={COLORS.textMuted}
                    value={form.category}
                    onChangeText={(text) => setForm({ ...form, category: text })}
                  />
                </View>
              </View>

              <AppText size="xs" color={COLORS.textMuted} style={styles.label}>Customer Group</AppText>
              <TextInput
                style={styles.input}
                placeholder="e.g. Lakhtokia Market"
                placeholderTextColor={COLORS.textMuted}
                value={form.group_name}
                onChangeText={(text) => setForm({ ...form, group_name: text })}
              />

              <AppText size="xs" color={COLORS.textMuted} style={styles.label}>Full Address</AppText>
              <TextInput
                style={styles.input}
                placeholder="Shop address, street, landmark"
                placeholderTextColor={COLORS.textMuted}
                value={form.address}
                onChangeText={(text) => setForm({ ...form, address: text })}
              />

              <View style={styles.row}>
                <View style={styles.flex}>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.label}>City</AppText>
                  <TextInput
                    style={styles.input}
                    value={form.city}
                    placeholderTextColor={COLORS.textMuted}
                    onChangeText={(text) => setForm({ ...form, city: text })}
                  />
                </View>

                <View style={styles.flex}>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.label}>GSTIN</AppText>
                  <TextInput
                    style={styles.input}
                    placeholder="27AAAAA0000A1Z5"
                    placeholderTextColor={COLORS.textMuted}
                    value={form.gst_number}
                    onChangeText={(text) => setForm({ ...form, gst_number: text })}
                  />
                </View>
              </View>

              {/* GPS Capture Action */}
              <TouchableOpacity style={styles.gpsBtn} onPress={handleCaptureGps}>
                <AppText size="xs" weight="bold" color={COLORS.secondary}>
                  🛰 {form.latitude ? `GPS Tagged (${form.latitude}, ${form.longitude})` : 'Auto-Capture GPS Location'}
                </AppText>
              </TouchableOpacity>
            </ScrollView>

            <View style={styles.modalActions}>
              <Button
                label="Cancel"
                type="secondary"
                style={styles.halfBtn}
                onPress={() => setOnboardModalVisible(false)}
              />
              <Button
                label="Onboard Customer"
                loading={submitting}
                style={styles.halfBtn}
                onPress={handleOnboardCustomer}
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: 10 },
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border
  },
  onboardBtn: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8
  },
  filterSection: { padding: 12, backgroundColor: COLORS.surface },
  searchInput: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: COLORS.text,
    marginBottom: 8
  },
  groupScroll: { flexDirection: 'row' },
  groupChip: {
    backgroundColor: COLORS.surfaceLight,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginRight: 6,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  groupChipActive: {
    backgroundColor: COLORS.primaryLight,
    borderColor: COLORS.primary
  },
  loadError: { marginHorizontal: 16, marginBottom: 12 },
  loaderCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scrollContent: { padding: 12, paddingBottom: 40 },
  customerCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  catBadge: {
    backgroundColor: COLORS.secondaryLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  custName: { marginBottom: 2 },
  balanceBox: { alignItems: 'flex-end' },
  cardBody: { borderTopWidth: 1, borderTopColor: COLORS.divider, paddingTop: 8, marginTop: 4 },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8
  },
  callBtn: {
    backgroundColor: COLORS.primaryLight,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '85%'
  },
  modalTitle: { marginBottom: 12 },
  modalForm: { marginVertical: 8 },
  label: { marginBottom: 4, marginTop: 8 },
  input: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: COLORS.text
  },
  gpsBtn: {
    backgroundColor: COLORS.secondaryLight,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginVertical: 14
  },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  halfBtn: { flex: 1 }
});
