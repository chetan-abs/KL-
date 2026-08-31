import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { PERMISSION_PAGES, actionsFor, WILDCARD } from '../../constants/permissions';
import { SHIFTS } from '../../constants/options';
import { Users } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { userCan } from '../../utils/permissions';
import { confirmAction, showAlert } from '../../services/confirm';
import { rupees } from '../../utils/format';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import Field from '../../components/mobile/Field';
import Select from '../../components/mobile/Select';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Who can do what.
 *
 * Grants are the only source of authority — `role` is deliberately ignored by
 * both `userCan()` and every route — so this screen is the whole of access
 * control, and revoking a grant here actually removes the ability rather than
 * hiding a button.
 *
 * Each page carries its own action set: the pipeline duties are not
 * view/create/edit/delete, so `actionsFor()` decides the chips rather than a
 * fixed four-column grid, which could not have offered `picking.record` or
 * `dispatch.build` at all.
 *
 * Requires `employees.permissions`, which is a step removed from
 * `employees.edit` on purpose: letting anyone who can fix a typo also widen
 * their own rights is an escalation route.
 */
export default function PeopleScreen({ role, user, nav, onNewEmployee }) {
  const { data, loading, error, refreshing, reload, refresh } = useApi(() => Users.list(), []);
  const [openId, setOpenId] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [shiftDraft, setShiftDraft] = React.useState('A');
  const [salaryDraft, setSalaryDraft] = React.useState('');

  const staff = (data?.employees || []).filter((u) => u.is_active);
  const canCreate = userCan(user, 'employees.create');
  // A.1 — "The salary amount is editable only by Yash or Manoj." The same
  // grant the server checks on the write itself, so this field only appears
  // where the request would actually be accepted.
  const canSetSalary = userCan(user, 'employees.permissions');

  const save = useAction(({ id, permissions }) => Users.setPermissions(id, permissions), {
    onDone: () => {
      showAlert('Permissions saved', 'The change takes effect on their next request.');
      setOpenId(null);
      setDraft(null);
      reload();
    },
    onFail: (message) => showAlert('Could not save', message),
  });

  const saveWork = useAction(
    ({ id, shift_code, fixed_salary }) => Users.update(id, { shift_code, fixed_salary }),
    {
      onDone: () => {
        showAlert('Saved', 'Shift and salary updated.');
        reload();
      },
      onFail: (message) => showAlert('Could not save', message),
    }
  );

  function open(person) {
    if (openId === person.id) {
      setOpenId(null);
      setDraft(null);
      return;
    }
    setOpenId(person.id);
    // A wildcard account is expanded into explicit grants the moment it is
    // edited, so a toggle has something concrete to remove.
    const granted = Array.isArray(person.permissions)
      ? person.permissions
      : JSON.parse(person.permissions || '[]');
    setDraft(
      granted.includes(WILDCARD)
        ? PERMISSION_PAGES.flatMap((p) => actionsFor(p).map((a) => `${p.key}.${a.key}`))
        : granted
    );
    setShiftDraft(person.shift_code || 'A');
    setSalaryDraft(String(Number(person.fixed_salary) || 0));
  }

  function toggle(pageKey, actionKey) {
    const key = `${pageKey}.${actionKey}`;
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        // Unticking View clears the page: every other action implies being able
        // to see it, so leaving them grants an ability through a shut door.
        if (actionKey === 'view') {
          const page = PERMISSION_PAGES.find((p) => p.key === pageKey);
          actionsFor(page).forEach((a) => next.delete(`${pageKey}.${a.key}`));
        }
      } else {
        next.add(key);
        next.add(`${pageKey}.view`);
      }
      return [...next];
    });
  }

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="People"
          subtitle={loading ? 'Loading…' : `${staff.length} active`}
          badge="Access"
          badgeTone="onBrand"
          action={canCreate ? { label: '+ New', onPress: onNewEmployee } : null}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload} empty={!staff.length}>
        <NoticeBar tone="info" glyph="🔑">
          Grants are the only thing that decides what someone can do. Revoking one takes effect on
          their next request, not when their session expires.
        </NoticeBar>

        {staff.map((person) => {
          const isOpen = openId === person.id;
          const granted = Array.isArray(person.permissions)
            ? person.permissions
            : JSON.parse(person.permissions || '[]');
          const wildcard = granted.includes(WILDCARD);
          const self = person.id === user?.id;

          return (
            <Card key={person.id} style={styles.person}>
              <TouchableOpacity
                style={styles.head}
                onPress={() => open(person)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={`${person.name}, edit permissions`}
              >
                <Avatar name={person.name} size={40} />
                <View style={styles.headBody}>
                  <AppText weight="bold" size="sm">{person.name}</AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {`${person.id} · ${wildcard ? 'full access' : `${granted.length} grant(s)`}`}
                  </AppText>
                </View>
                {wildcard ? <Badge tone="violet">All</Badge> : null}
                <AppText size="md" color={COLORS.textSecondary}>{isOpen ? '⌃' : '⌄'}</AppText>
              </TouchableOpacity>

              {isOpen ? (
                <View style={styles.grid}>
                  {self ? (
                    <NoticeBar tone="warning" style={styles.selfWarn}>
                      This is your own account. Removing a grant here can lock you out of a screen.
                    </NoticeBar>
                  ) : null}

                  {canSetSalary ? (
                    <View style={styles.workBlock}>
                      <AppText weight="bold" size={11} color={COLORS.textSecondary} style={styles.workLabel}>
                        SHIFT & SALARY — A.1
                      </AppText>
                      <Select
                        label="Shift"
                        value={shiftDraft}
                        options={SHIFTS.map((s) => ({ value: s.value, label: `${s.label} — ${s.caption}` }))}
                        onChange={setShiftDraft}
                      />
                      <Field
                        label="Fixed monthly salary (₹)"
                        style={styles.spaced}
                        value={salaryDraft}
                        onChangeText={setSalaryDraft}
                        keyboardType="numeric"
                      />
                      <ActionButton
                        label={`Save shift & salary${Number(salaryDraft) ? ` — ${rupees(salaryDraft)}` : ''}`}
                        tone="neutral"
                        size="sm"
                        loading={saveWork.busy}
                        style={styles.spaced}
                        onPress={() =>
                          confirmAction(
                            `Set ${person.name}'s salary?`,
                            `Shift ${shiftDraft} · ${rupees(salaryDraft)} / month. Takes effect this pay period.`,
                            () => saveWork.run({ id: person.id, shift_code: shiftDraft, fixed_salary: Number(salaryDraft) || 0 })
                          )
                        }
                      />
                    </View>
                  ) : null}

                  {PERMISSION_PAGES.map((page) => (
                    <View key={page.key} style={styles.pageRow}>
                      <AppText size="xs" color={COLORS.text} style={styles.pageLabel}>
                        {page.label}
                      </AppText>
                      <View style={styles.chips}>
                        {actionsFor(page).map((action) => {
                          const key = `${page.key}.${action.key}`;
                          const on = (draft || []).includes(key);
                          return (
                            <TouchableOpacity
                              key={action.key}
                              style={[styles.chip, on ? styles.chipOn : null]}
                              onPress={() => toggle(page.key, action.key)}
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked: on }}
                              accessibilityLabel={`${action.label} ${page.label}`}
                            >
                              <AppText
                                weight={on ? 'bold' : 'regular'}
                                size={11}
                                color={on ? COLORS.white : COLORS.textSecondary}
                              >
                                {action.label}
                              </AppText>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  ))}

                  <ActionButton
                    label="Save permissions"
                    tone="brand"
                    size="sm"
                    loading={save.busy}
                    style={styles.save}
                    onPress={() =>
                      confirmAction(
                        `Save ${person.name}'s permissions?`,
                        `${(draft || []).length} grant(s). This takes effect on their next request.`,
                        () => save.run({ id: person.id, permissions: draft || [] })
                      )
                    }
                  />
                </View>
              ) : null}
            </Card>
          );
        })}
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  person: { marginBottom: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  headBody: { flex: 1 },
  meta: { marginTop: 3 },
  grid: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  selfWarn: { marginBottom: 12 },
  pageRow: { marginBottom: 12 },
  pageLabel: { marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  chipOn: { backgroundColor: COLORS.brand, borderColor: COLORS.brand },
  save: { marginTop: 6 },
  workBlock: {
    marginBottom: 16, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: COLORS.borderLight,
  },
  workLabel: { letterSpacing: 0.6, marginBottom: 10 },
  spaced: { marginTop: 11 },
});
