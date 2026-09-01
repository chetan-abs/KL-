import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { AGENT_TYPES, AGENT_PRIVACY_NOTE } from '../../constants/options';
import { Agents } from '../../services/endpoints';
import { useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Field from '../../components/mobile/Field';
import ChoiceCards from '../../components/mobile/ChoiceCards';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';

/**
 * 05 — Commission agent. Shown when the customer type is Commission; the agent
 * type is mandatory because it picks the rate column (21 for builders, 20 for
 * electricians and interior), and the commission cannot be computed without it.
 *
 * The lookup is by phone, not by name: a name is spelled six ways across a
 * ledger and a phone number is not, and the salesman standing in the shop has
 * the number in front of them. The server normalises the comparison, so
 * "98765-11223" finds a row saved as "9876511223".
 *
 * The privacy note is not decoration. Agent identity and commission stay off the
 * printed invoice (R21) — the party must not see what their agent is paid — and
 * the billing route is written so it has no reason to read these tables at all.
 */
export default function CommissionAgentScreen({ role, onBack, onAddAgent, onContinue, nav}) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  right: { alignItems: 'flex-end' },
  typeNote: { marginTop: 11 },
  search: { paddingHorizontal: 18, marginTop: 20 },

  found: {
    marginTop: 14,
    backgroundColor: COLORS.infoRow,
    borderWidth: 1,
    borderColor: COLORS.infoBorder,
    borderRadius: 11,
    padding: 13,
  },
  foundHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  foundMeta: { marginTop: 2, marginBottom: 1 },
  foundStats: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: 12,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: COLORS.infoBorder,
  },
  notFound: { marginTop: 14 },

  add: {
    marginTop: 13,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.border,
    alignItems: 'center',
  },
}), [COLORS]);
  const [type, setType] = React.useState('builder');
  const [phone, setPhone] = React.useState('');
  const [found, setFound] = React.useState(undefined); // undefined = not searched
  const selected = AGENT_TYPES.find((option) => option.value === type);

  const search = useAction(() => Agents.byPhone(phone.trim()), {
    onDone: (result) => setFound(result.agent),
    onFail: () => setFound(null),
  });

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Commission Agent"
          subtitle="Select agent type + search"
          onBack={onBack}
          backLabel="Order"
          badge="Commission"
          badgeTone="violet"
        />
      }
      footer={
        <ActionButton
          label="Continue to Order  →"
          tone="brand"
          disabled={!found}
          onPress={onContinue}
        />
      }
    >
      <Card title="Agent type *">
        <ChoiceCards options={AGENT_TYPES} value={type} onChange={setType} />
        <AppText size="xs" color={COLORS.primary} style={styles.typeNote}>
          {`${selected?.label} selected → ${selected?.column} commission rates apply`}
        </AppText>
      </Card>

      <Card>
        <Field
          label="Agent Phone (search)"
          required
          value={phone}
          onChangeText={(next) => {
            setPhone(next);
            setFound(undefined);
          }}
          keyboardType="phone-pad"
          placeholder="98765-11223"
          right={
            <ActionButton
              label="Search"
              tone="brand"
              size="sm"
              loading={search.busy}
              disabled={!phone.trim()}
              onPress={search.run}
              style={styles.search}
            />
          }
        />

        {found ? (
          <View style={styles.found}>
            <View style={styles.foundHead}>
              <View style={styles.flex}>
                <AppText weight="bold" size="sm">{found.name}</AppText>
                <AppText size="xs" color={COLORS.primary} style={styles.foundMeta}>
                  {`${found.agent_type === 'builder' ? 'Builder Agent' : 'Elec / Interior'} · Existing ledger ✓`}
                </AppText>
                <AppText size="xs" color={COLORS.textSecondary}>{found.phone}</AppText>
              </View>
              <Badge tone="info">Found</Badge>
            </View>

            <View style={styles.foundStats}>
              <View style={styles.flex}>
                <AppText size="xs" color={COLORS.textSecondary}>Pending</AppText>
                <AppText weight="bold" size="md" color={COLORS.primary}>
                  {rupees(found.pending_amount || 0)}
                </AppText>
              </View>
              <View style={styles.right}>
                <AppText size="xs" color={COLORS.textSecondary}>This Month</AppText>
                <AppText weight="bold" size="md" color={COLORS.success}>
                  {rupees(found.month_amount || 0)}
                </AppText>
              </View>
            </View>
          </View>
        ) : found === null ? (
          <NoticeBar tone="warning" style={styles.notFound}>
            No agent on that number. Add them as a permanent ledger below.
          </NoticeBar>
        ) : null}

        <TouchableOpacity
          style={styles.add}
          onPress={onAddAgent}
          accessibilityRole="button"
          accessibilityLabel="Add a new agent"
        >
          <AppText weight="bold" size="sm" color={COLORS.textSecondary}>+ Add New Agent</AppText>
        </TouchableOpacity>
      </Card>

      <NoticeBar tone="warning">{AGENT_PRIVACY_NOTE}</NoticeBar>
    </Screen>
  );
}


