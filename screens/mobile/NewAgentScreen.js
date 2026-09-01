import React from 'react';
import { StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { AGENT_TYPES, PROFESSIONS } from '../../constants/options';
import { Agents } from '../../services/endpoints';
import { useAction } from '../../hooks/useApi';
import { showAlert } from '../../services/confirm';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Field from '../../components/mobile/Field';
import Select from '../../components/mobile/Select';
import ChoiceCards from '../../components/mobile/ChoiceCards';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';

/**
 * 06 — New agent. Reached when the phone lookup on 05 finds nobody.
 *
 * The agent is saved as a permanent ledger rather than attached to this one
 * order, which is what the violet note at the top promises: every future order
 * carrying this number tracks commission automatically, and the salesman never
 * has to key the rates again.
 *
 * Agent type is asked first and marked required for the same reason as on 05 —
 * it selects the commission column, and a ledger created without it would owe an
 * amount nobody can compute.
 */
export default function NewAgentScreen({ role, onBack, onSaved, nav}) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  spaced: { marginTop: 13 },
}), [COLORS]);
  const [type, setType] = React.useState('electrician');
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('97654-88901');
  const [area, setArea] = React.useState('');
  const [profession, setProfession] = React.useState('electrician');
  const [errors, setErrors] = React.useState({});

  const create = useAction(
    () =>
      Agents.create({
        name: name.trim(),
        phone: phone.trim(),
        agent_type: type,
        area: area.trim() || null,
        profession,
      }),
    {
      onDone: () => {
        showAlert('Agent saved', `${name.trim()} now has a permanent commission ledger.`);
        onSaved?.();
      },
      // A duplicate phone is the expected collision — the number is the lookup
      // key, so the server's unique index is what decides, not a pre-check.
      onFail: (message) => setErrors({ phone: message }),
    }
  );

  function save() {
    const next = {};
    if (!name.trim()) next.name = 'Enter the agent’s full name.';
    if (!phone.trim()) next.phone = 'A phone number is how the agent is found later.';

    setErrors(next);
    if (Object.keys(next).length) return;
    create.run();
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock="2:35"
          role={role.name}
          title="New Agent"
          subtitle="Create permanent ledger"
          onBack={onBack}
          backLabel="Agent"
          badge="New"
          badgeTone="info"
        />
      }
      footer={
        <ActionButton
          label="Save Agent + Continue  →"
          tone="teal"
          loading={create.busy}
          loadingLabel="Saving"
          onPress={save}
        />
      }
    >
      <NoticeBar tone="violet">
        Agent saved permanently. Commission auto-tracked on all future orders.
      </NoticeBar>

      <Card title="Agent type *">
        <ChoiceCards
          options={AGENT_TYPES.map((option) => ({
            ...option,
            accent: option.value === 'electrician' ? COLORS.accent : COLORS.primary,
          }))}
          value={type}
          onChange={setType}
        />
      </Card>

      <Card>
        <Field
          label="Full Name"
          required
          value={name}
          onChangeText={setName}
          placeholder="Agent full name"
          error={errors.name}
        />
        <Field
          label="Phone"
          required
          style={styles.spaced}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          error={errors.phone}
        />
        <Field
          label="Area"
          style={styles.spaced}
          value={area}
          onChangeText={setArea}
          placeholder="e.g. Basistha"
        />
        <Select
          label="Profession"
          style={styles.spaced}
          value={profession}
          options={PROFESSIONS}
          onChange={setProfession}
        />
      </Card>
    </Screen>
  );
}


