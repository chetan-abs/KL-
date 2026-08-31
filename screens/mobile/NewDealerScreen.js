import React from 'react';
import { StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { NEW_DEALER_FIELDS } from '../../constants/options';
import { Customers } from '../../services/endpoints';
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
 * 22 — Onboard a dealer, from the field.
 *
 * The credit limit is asked for but starts at zero, and a new party with no
 * limit can still be sold to for cash. Defaulting it to a number the salesman
 * chose in a shop would make the first order self-approving, which is exactly
 * what Manas's queue exists to prevent.
 *
 * GST is optional because a good share of counter dealers are unregistered; the
 * number is validated in shape only, and the office confirms it before the
 * account is used for a credit sale.
 */
export default function NewDealerScreen({ role, onBack, onSaved, nav}) {
  const [type, setType] = React.useState('dealer');
  const [name, setName] = React.useState('');
  const [person, setPerson] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [area, setArea] = React.useState('basistha');
  const [gst, setGst] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [errors, setErrors] = React.useState({});

  const gstLooksWrong = gst.length > 0 && gst.length !== 15;

  const create = useAction(
    () =>
      Customers.create({
        name: name.trim(),
        person_name: person.trim() || null,
        phone: phone.trim(),
        city: NEW_DEALER_FIELDS.areas.find((a) => a.value === area)?.label,
        address: address.trim() || null,
        gst_number: gst.trim() || null,
        category: type === 'builder' ? 'Builder' : 'Dealer',
        // Starts at zero deliberately: a limit the salesman chose in a shop
        // would make the party's first order self-approving, which is exactly
        // what the approval queue exists to prevent.
        credit_limit: 0,
      }),
    {
      onDone: () => {
        showAlert(
          'Dealer created',
          `${name.trim()} onboarded. Credit limit starts at ₹0 until the office sets one.`
        );
        onSaved?.();
      },
      onFail: (message) => showAlert('Could not create', message),
    }
  );

  function save() {
    const next = {};
    if (!name.trim()) next.name = 'The trading name is how the party is found.';
    if (!phone.trim()) next.phone = 'A phone number is required.';
    if (gstLooksWrong) next.gst = 'A GSTIN is 15 characters.';

    setErrors(next);
    if (Object.keys(next).length) return;
    create.run();
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock="15:50"
          role={role.name}
          title="New Dealer"
          subtitle="Onboard from the field"
          onBack={onBack}
          backLabel="Today"
          badge="New"
          badgeTone="info"
        />
      }
      footer={
        <ActionButton
          label="Create Dealer"
          tone="teal"
          loading={create.busy}
          loadingLabel="Creating"
          onPress={save}
        />
      }
    >
      <Card title="Party type *">
        <ChoiceCards
          options={NEW_DEALER_FIELDS.types.map((option) => ({
            ...option,
            accent: option.value === 'builder' ? COLORS.accent : COLORS.primary,
          }))}
          value={type}
          onChange={setType}
        />
      </Card>

      <Card title="Details">
        <Field
          label="Trading name"
          required
          value={name}
          onChangeText={setName}
          placeholder="e.g. Sharma Electricals"
          error={errors.name}
        />
        <Field
          label="Contact person"
          style={styles.spaced}
          value={person}
          onChangeText={setPerson}
          placeholder="Who to ask for"
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
        <Select
          label="Area"
          style={styles.spaced}
          value={area}
          options={NEW_DEALER_FIELDS.areas}
          onChange={setArea}
        />
        <Field
          label="Address"
          style={styles.spaced}
          value={address}
          onChangeText={setAddress}
          multiline
        />
      </Card>

      <Card title="Tax">
        <Field
          label="GSTIN"
          value={gst}
          onChangeText={(next) => setGst(next.toUpperCase())}
          autoCapitalize="characters"
          maxLength={15}
          error={errors.gst}
          hint="Optional — leave blank for an unregistered counter dealer"
        />
      </Card>

      <NoticeBar tone="warning">
        Credit limit starts at ₹0. The first credit order needs Manas to set one.
      </NoticeBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaced: { marginTop: 13 },
});
