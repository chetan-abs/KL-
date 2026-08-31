import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  Modal,
  TextInput,
  ScrollView,
  Platform,
  useWindowDimensions
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import AppText from '../components/AppText';
import Button from '../components/Button';
import api, { describeError } from '../services/api';
import { confirmAction, showAlert } from '../services/confirm';
import { checkPassword } from '../utils/password';
import { normalizeSearch, isSearchActive } from '../utils/search';
import { useAuth } from '../context/AuthContext';
import { userCan, parsePermissions } from '../utils/permissions';
import { PERMISSION_PAGES, actionsFor, WILDCARD } from '../constants/permissions';

const TABLE_WIDTH = 960;

// Below this the form falls back to one field per row; two columns at phone
// width leaves each input too narrow to read what has been typed into it.
const TWO_COLUMN_MIN_WIDTH = 620;

export default function EmployeeListScreen() {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const twoColumn = width >= TWO_COLUMN_MIN_WIDTH;

  // What the signed-in admin may do to other accounts. Handing out permissions
  // is held to a stricter grant than editing a name: 'employees.edit' is enough
  // to fix a phone number, but only a wildcard (or an explicit
  // 'employees.permissions') can widen someone else's access — otherwise anyone
  // who can edit employees could grant themselves everything.
  const canCreate = userCan(user, 'employees.create');
  const canEdit = userCan(user, 'employees.edit');
  const canDelete = userCan(user, 'employees.delete');
  const canGrantPermissions = userCan(user, 'employees.permissions');

  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  
  // Add User Modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPhone, setNewUserPhone] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [savingUser, setSavingUser] = useState(false);

  // Page permissions being edited, as the flat grant strings the server stores.
  // `permissionsDirty` exists so an untouched form never rewrites what is
  // already on the account — an admin holding ["all"] shows every box ticked,
  // and saving without touching the grid must leave that wildcard intact rather
  // than silently flattening it into a list of individual grants.
  const [newUserPermissions, setNewUserPermissions] = useState([]);
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [hasWildcard, setHasWildcard] = useState(false);

  const grantKey = (page, action) => `${page}.${action}`;

  const isGranted = (page, action) =>
    hasWildcard || newUserPermissions.includes(grantKey(page, action));

  // View is the floor: an account that may create or delete on a page must be
  // able to open it, and revoking view revokes the page outright.
  const togglePermission = (page, action) => {
    setPermissionsDirty(true);
    setNewUserPermissions((prev) => {
      // The first edit to a wildcard account expands it into explicit grants so
      // the toggle has something concrete to remove.
      const current = hasWildcard
        ? PERMISSION_PAGES.flatMap((p) => actionsFor(p).map((a) => grantKey(p.key, a.key)))
        : prev;
      const key = grantKey(page, action);
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
        if (action === 'view') {
          // Unticking View clears the page: every other action on it implies
          // being able to see the page, so leaving them would grant an ability
          // through a door that is now shut.
          const definition = PERMISSION_PAGES.find((p) => p.key === page);
          actionsFor(definition).forEach((a) => next.delete(grantKey(page, a.key)));
        }
      } else {
        next.add(key);
        next.add(grantKey(page, 'view'));
      }
      return [...next];
    });
    setHasWildcard(false);
  };

  const resetForm = () => {
    setNewUserId('');
    setNewUserName('');
    setNewUserEmail('');
    setNewUserPhone('');
    setNewUserPassword('');
    setNewUserPermissions([]);
    setPermissionsDirty(false);
    setHasWildcard(false);
  };

  useEffect(() => {
    loadEmployees();
  }, []);

  const loadEmployees = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await api.get('/users/employees');
      setEmployees(res.data.employees || []);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveUser = async () => {
    if (!newUserId.trim() || !newUserName.trim()) {
      showAlert('Missing details', 'Employee ID/Username and Name are required.');
      return;
    }

    // The same rule the server applies, checked here so the reader is told
    // before the round trip. There is deliberately no default: a blank field
    // used to be filled in with 'password123' without saying so, which gave
    // every hurriedly-created account a password published in the source.
    const password = newUserPassword.trim();
    if (!isEditing || password) {
      const passwordError = checkPassword(password);
      if (passwordError) {
        showAlert('Password', passwordError);
        return;
      }
    }

    setSavingUser(true);
    try {
      const payload = {
        name: newUserName,
        email: newUserEmail,
        phone: newUserPhone,
      };
      if (password) {
        payload.password = password;
      }
      // Omitted entirely when untouched: the server only writes the column when
      // the field is an array, so leaving it out preserves the existing grants.
      if (canGrantPermissions && (permissionsDirty || !isEditing)) {
        payload.permissions = hasWildcard ? [WILDCARD] : newUserPermissions;
      }

      if (isEditing) {
        // role is not sent. This form used to post role: 'employee' on every
        // save, so correcting an administrator's phone number demoted them.
        const res = await api.put(`/users/${newUserId}`, payload);
        setEmployees(prev => prev.map(emp => emp.id === newUserId ? res.data.employee : emp));
      } else {
        payload.id = newUserId;
        payload.role = 'employee';
        const res = await api.post('/users', payload);
        setEmployees(prev => [res.data.employee, ...prev]);
      }

      // Reset and close
      setShowAddModal(false);
      resetForm();
      setIsEditing(false);
    } catch (err) {
      showAlert(`Failed to ${isEditing ? 'edit' : 'add'} user`, describeError(err));
    } finally {
      setSavingUser(false);
    }
  };

  const handleEditClick = (employee) => {
    const granted = parsePermissions(employee.permissions);
    setNewUserId(employee.id);
    setNewUserName(employee.name);
    setNewUserEmail(employee.email || '');
    setNewUserPhone(employee.phone || '');
    setNewUserPassword('');
    setNewUserPermissions(granted.filter((p) => p !== WILDCARD));
    setHasWildcard(granted.includes(WILDCARD));
    setPermissionsDirty(false);
    setIsEditing(true);
    setShowAddModal(true);
  };

  const handleDeleteUser = (userId) => {
    // confirmAction rather than Alert.alert: react-native-web implements Alert
    // as an empty function, so on the web admin panel the dialog never appeared
    // and the delete — which lived in its button callback — never ran.
    confirmAction(
      'Delete Employee',
      'Deleting removes this employee along with every attendance record and GPS point attached to them. Deactivating keeps the history and blocks sign-in. This cannot be undone.',
      async () => {
        try {
          await api.delete(`/users/${userId}`);
          setEmployees(prev => prev.filter(emp => emp.id !== userId));
        } catch (err) {
          showAlert('Failed to delete user', describeError(err));
        }
      }
    );
  };

  // There is deliberately no "Delete All" any more. It called an endpoint that
  // ran DELETE FROM users WHERE role = 'employee', and checkins and
  // location_logs cascade from users — so one tap destroyed every attendance
  // record and every GPS ping the company held, behind a confirm dialog that
  // did nothing at all on web. Offboarding is the Active toggle, and it can be
  // undone.

  const handleToggleStatus = async (employee) => {
    const newStatus = !employee.is_active;
    try {
      await api.patch(`/users/${employee.id}/status`, { is_active: newStatus });
      setEmployees(prev => prev.map(emp => emp.id === employee.id ? { ...emp, is_active: newStatus ? 1 : 0 } : emp));
    } catch (err) {
      showAlert('Failed to update status', describeError(err));
    }
  };

  // Computations
  const filteredEmployees = React.useMemo(() => {
    if (!isSearchActive(searchQuery)) return employees;
    const q = normalizeSearch(searchQuery);
    return employees.filter(emp =>
      normalizeSearch(emp.name).includes(q) ||
      normalizeSearch(emp.id).includes(q)
    );
  }, [employees, searchQuery]);

  const renderRow = ({ item, index }) => {
    const isActive = item.is_active === 1 || item.is_active === true;
    const isEmployee = item.role === 'employee' || item.role?.toLowerCase() === 'employee';
    
    return (
      <View style={[styles.tableRow, index % 2 === 1 && styles.tableRowAlt]}>
        {/* Name Column */}
        <View style={[styles.tableCol, styles.colName]}>
          <AppText weight="bold" size="sm" color={COLORS.text}>
            {item.name}
          </AppText>
        </View>
        
        {/* Phone Column */}
        <View style={[styles.tableCol, styles.colPhone]}>
          <AppText size="sm" color={COLORS.text}>
            {item.phone || 'No Phone'}
          </AppText>
        </View>
        
        {/* Role Column */}
        <View style={[styles.tableCol, styles.colRole]}>
          <AppText size="xs" weight="bold" color={COLORS.textSecondary}>
            {String(item.role || 'employee').toUpperCase()}
          </AppText>
        </View>
        
        {/* Status Column */}
        <View style={[styles.tableCol, styles.colStatus]}>
          <AppText size="xs" weight="bold" color={isActive ? COLORS.success : COLORS.textMuted}>
            {isActive ? 'ACTIVE' : 'INACTIVE'}
          </AppText>
        </View>
        
        {/* Actions Column */}
        <View style={[styles.tableCol, styles.colActions]}>
          {canEdit && (
            <TouchableOpacity onPress={() => handleEditClick(item)} style={styles.rowActionBtn}>
              <MaterialCommunityIcons name="pencil-outline" size={18} color="#3B82F6" />
            </TouchableOpacity>
          )}
          {canEdit && (
            <TouchableOpacity onPress={() => handleToggleStatus(item)} style={styles.rowActionBtn}>
              <MaterialCommunityIcons name="account-cancel-outline" size={18} color="#F97316" />
            </TouchableOpacity>
          )}
          {isEmployee && canDelete && (
            <TouchableOpacity onPress={() => handleDeleteUser(item.id)} style={styles.rowActionBtn}>
              <MaterialCommunityIcons name="trash-can-outline" size={18} color={COLORS.error} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>

      {/* Action Bar */}
      <View style={styles.actionBar}>
        <View style={styles.searchBar}>
          <MaterialCommunityIcons name="magnify" size={18} color={COLORS.textMuted} style={styles.searchIcon} />
          <TextInput
            placeholder="Search by name or ID..."
            placeholderTextColor={COLORS.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            style={styles.searchInput}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <MaterialCommunityIcons name="close-circle" size={16} color={COLORS.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={COLORS.primary} style={styles.center} />
      ) : error ? (
        <View style={styles.center}>
          <AppText color={COLORS.error}>{error}</AppText>
          <TouchableOpacity onPress={loadEmployees} style={styles.retryBtn}>
            <AppText weight="bold" color={COLORS.primary}>Retry</AppText>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView horizontal={true} style={styles.horizontalScroll} contentContainerStyle={styles.horizontalScrollContent} showsHorizontalScrollIndicator={true}>
          <View style={styles.table}>
            
            {/* Table Header */}
            <View style={styles.tableHeader}>
              <View style={[styles.tableCol, styles.colName]}>
                <AppText weight="bold" size="xs" color={COLORS.textSecondary}>EMPLOYEE NAME</AppText>
              </View>
              <View style={[styles.tableCol, styles.colPhone]}>
                <AppText weight="bold" size="xs" color={COLORS.textSecondary}>PHONE NUMBER</AppText>
              </View>
              <View style={[styles.tableCol, styles.colRole]}>
                <AppText weight="bold" size="xs" color={COLORS.textSecondary}>ROLE</AppText>
              </View>
              <View style={[styles.tableCol, styles.colStatus]}>
                <AppText weight="bold" size="xs" color={COLORS.textSecondary}>STATUS</AppText>
              </View>
              <View style={[styles.tableCol, styles.colActions]}>
                <AppText weight="bold" size="xs" color={COLORS.textSecondary}>ACTIONS</AppText>
              </View>
            </View>

            {/* Table Rows List */}
            <FlatList
              data={filteredEmployees}
              keyExtractor={(item) => item.id}
              renderItem={renderRow}
              ListEmptyComponent={
                <View style={styles.emptyList}>
                  <AppText color={COLORS.textMuted}>No employees found</AppText>
                </View>
              }
            />
          </View>
        </ScrollView>
      )}

      {/* Floating Action Button (FAB) */}
      {canCreate && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => {
            setIsEditing(false);
            resetForm();
            setShowAddModal(true);
          }}
        >
          <MaterialCommunityIcons name="account-plus" size={24} color={COLORS.white} />
        </TouchableOpacity>
      )}

      {/* Add/Edit User Modal */}
      <Modal visible={showAddModal} transparent={true} animationType="slide" onRequestClose={() => setShowAddModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <AppText weight="bold" size="lg" color={COLORS.text}>
                {isEditing ? 'Edit Employee' : 'Add New Employee'}
              </AppText>
              <TouchableOpacity onPress={() => setShowAddModal(false)}>
                <MaterialCommunityIcons name="close" size={20} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>
            
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={[styles.formRow, !twoColumn && styles.formRowStacked]}>
                <View style={styles.formGroup}>
                  <AppText size="sm" color={COLORS.textSecondary} style={styles.label}>Employee ID / Username *</AppText>
                  <TextInput
                    style={[styles.input, isEditing && styles.inputDisabled]}
                    placeholder="e.g. EMP001"
                    value={newUserId}
                    onChangeText={setNewUserId}
                    editable={!isEditing}
                  />
                </View>

                <View style={styles.formGroup}>
                  <AppText size="sm" color={COLORS.textSecondary} style={styles.label}>Full Name *</AppText>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter full name"
                    value={newUserName}
                    onChangeText={setNewUserName}
                  />
                </View>
              </View>

              <View style={[styles.formRow, !twoColumn && styles.formRowStacked]}>
                <View style={styles.formGroup}>
                  <AppText size="sm" color={COLORS.textSecondary} style={styles.label}>Email</AppText>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter email address"
                    value={newUserEmail}
                    onChangeText={setNewUserEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>

                <View style={styles.formGroup}>
                  <AppText size="sm" color={COLORS.textSecondary} style={styles.label}>Phone Number</AppText>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter phone number"
                    value={newUserPhone}
                    onChangeText={setNewUserPhone}
                    keyboardType="phone-pad"
                  />
                </View>
              </View>

              <View style={[styles.formRow, !twoColumn && styles.formRowStacked]}>
                <View style={styles.formGroup}>
                  <AppText size="sm" color={COLORS.textSecondary} style={styles.label}>
                    {isEditing ? 'New Password (optional)' : 'Password *'}
                  </AppText>
                  <TextInput
                    style={styles.input}
                    placeholder={isEditing ? "Leave blank to keep current" : "Enter password"}
                    value={newUserPassword}
                    onChangeText={setNewUserPassword}
                    secureTextEntry={true}
                  />
                </View>
                {/* Keeps the password field the same width as the fields above
                    it instead of stretching across the whole dialog. */}
                {twoColumn && <View style={styles.formGroup} />}
              </View>

              {canGrantPermissions && (
                <View style={styles.permissionSection}>
                  <AppText weight="bold" size="sm" color={COLORS.text}>Page Permissions</AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={{ marginTop: 2, marginBottom: 12 }}>
                    {hasWildcard
                      ? 'This account has full access. Changing anything below replaces it with the exact pages ticked.'
                      : 'Only the pages ticked here appear in this user\'s portal.'}
                  </AppText>

                  {/* Each page carries its own action set — the pipeline duties
                      are not view/create/edit/delete, and a fixed four-column
                      grid could not offer `picking.record` or `dispatch.build`
                      at all. Every checkbox is labelled beside itself rather
                      than by a column header, so the rows may differ in width. */}
                  {PERMISSION_PAGES.map((page) => (
                    <View key={page.key} style={styles.permissionRow}>
                      <AppText size="sm" color={COLORS.text} style={styles.permissionPageCol}>
                        {page.label}
                      </AppText>
                      {actionsFor(page).map((action) => {
                        const granted = isGranted(page.key, action.key);
                        return (
                          <TouchableOpacity
                            key={action.key}
                            style={styles.permissionActionCol}
                            onPress={() => togglePermission(page.key, action.key)}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: granted }}
                            accessibilityLabel={`${action.label} ${page.label}`}
                          >
                            <View style={[styles.checkbox, granted && styles.checkboxOn]}>
                              {granted && (
                                <MaterialCommunityIcons name="check" size={14} color={COLORS.white} />
                              )}
                            </View>
                            <AppText
                              size="xs"
                              color={granted ? COLORS.text : COLORS.textSecondary}
                              style={styles.permissionActionLabel}
                            >
                              {action.label}
                            </AppText>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ))}
                </View>
              )}

              <Button
                label={isEditing ? 'Save Changes' : 'Save Employee'}
                type="primary"
                onPress={handleSaveUser}
                loading={savingUser}
                style={{ marginTop: 12 }}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 38,
  },
  searchIcon: { marginRight: 6 },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    fontFamily: Platform.OS === 'ios' ? 'System' : 'AppFont-Regular',
    padding: 0
  },
  horizontalScroll: {
    backgroundColor: COLORS.background,
    flex: 1,
  },
  horizontalScrollContent: {
    minWidth: '100%',
  },
  table: {
    minWidth: TABLE_WIDTH,
    width: '100%',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: COLORS.surfaceLight,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    height: 44,
    alignItems: 'center'
  },
  tableRow: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    height: 62,
    alignItems: 'center'
  },
  tableRowAlt: {
    backgroundColor: COLORS.surfaceLight
  },
  tableCol: {
    justifyContent: 'center',
    paddingHorizontal: 12
  },
  colName: { width: '25%' },
  colPhone: { width: '31%' },
  colRole: { width: '13%' },
  colStatus: { width: '13%' },
  colActions: { width: '18%', flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowActionBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: COLORS.surfaceLight
  },
  emptyList: {
    paddingVertical: 60,
    alignItems: 'center'
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    padding: 20
  },
  modalContent: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 24,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 10,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    maxHeight: '90%'
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20
  },
  formRow: {
    flexDirection: 'row',
    gap: 16
  },
  formRowStacked: {
    flexDirection: 'column',
    gap: 0
  },
  formGroup: {
    flex: 1,
    marginBottom: 16
  },
  permissionSection: {
    marginTop: 4,
    marginBottom: 8,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background
  },
  permissionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // Wraps rather than scrolls: a page with five actions must not push its own
    // checkboxes off the dialog's right edge where nobody can tick them.
    flexWrap: 'wrap',
    rowGap: 6,
    columnGap: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderLight
  },
  // Fixed rather than flexed: the actions beside it are now variable in number,
  // and a flexed label would resize the whole row from one page to the next.
  permissionPageCol: {
    width: 130
  },
  permissionActionCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  permissionActionLabel: {
    marginLeft: 1
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkboxOn: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary
  },
  label: {
    marginBottom: 8
  },
  input: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: 12,
    color: COLORS.text,
    fontSize: 14
  },
  inputDisabled: {
    backgroundColor: COLORS.surfaceLight,
    color: COLORS.textMuted
  },
  retryBtn: {
    marginTop: 12,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary
  }
});
