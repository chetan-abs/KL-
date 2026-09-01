import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { NEW_ITEM_DEFAULTS } from '../../constants/options';
import { Items } from '../../services/endpoints';
import { useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Field from '../../components/mobile/Field';
import Select from '../../components/mobile/Select';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';

/**
 * 15 — New item in the master.
 *
 * The margin line is computed live because the two rates are entered a field
 * apart, and a transposed pair — cost above sale — is otherwise invisible until
 * the item has been sold at a loss.
 *
 * Opening stock is deliberately not captured here. Stock enters through a
 * purchase, which writes a `receipt` movement to the ledger; an opening figure
 * typed into the item master would be a quantity with no movement behind it, and
 * items.qty is a cache of movements, not a number anyone types.
 */
export default function NewItemScreen({ role, nav }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  pair: { flexDirection: 'row', gap: 11 },
  spaced: { marginTop: 13 },
  margin: { marginTop: 10 },
}), [COLORS]);
  const [name, setName] = React.useState('');
  const [brand, setBrand] = React.useState('polycab');
  const [category, setCategory] = React.useState('wire');
  const [unit, setUnit] = React.useState('pcs');
  const [hsn, setHsn] = React.useState('');
  const [gst, setGst] = React.useState('18');
  const [cost, setCost] = React.useState('');
  const [sale, setSale] = React.useState('');
  const [errors, setErrors] = React.useState({});

  const costNum = Number(cost) || 0;
  const saleNum = Number(sale) || 0;
  const margin = saleNum > 0 ? ((saleNum - costNum) / saleNum) * 100 : null;
  const inverted = costNum > 0 && saleNum > 0 && costNum > saleNum;

  const create = useAction(
    () =>
      Items.create({
        name: name.trim(),
        brand: NEW_ITEM_DEFAULTS.brands.find((b) => b.value === brand)?.label,
        category: NEW_ITEM_DEFAULTS.categories.find((c) => c.value === category)?.label,
        unit,
        hsn: hsn.trim() || null,
        gst_percent: Number(gst) || 0,
        rate: saleNum,
      }),
    {
      onDone: () => {
        showAlert('Item created', `${name.trim()} added. Stock arrives through a purchase.`);
        setName('');
        setHsn('');
        setCost('');
        setSale('');
      },
      onFail: (message) => showAlert('Could not create', message),
    }
  );

  function save() {
    const next = {};
    if (!name.trim()) next.name = 'An item needs a name.';
    if (!sale) next.sale = 'Enter the selling rate.';
    setErrors(next);
    if (Object.keys(next).length) return;
    create.run();
  }

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="New Item"
          subtitle="Add to item master"
          badge="New"
          badgeTone="info"
        />
      }
      nav={nav}
      footer={
        <ActionButton
          label="Create Item"
          tone="teal"
          loading={create.busy}
          loadingLabel="Creating"
          onPress={save}
        />
      }
    >
      <Card title="Identity">
        <Field
          label="Item name"
          required
          value={name}
          onChangeText={setName}
          placeholder="e.g. Polycab 6mm Wire"
          error={errors.name}
        />
        <Select label="Brand" style={styles.spaced} value={brand} options={NEW_ITEM_DEFAULTS.brands} onChange={setBrand} />
        <Select label="Category" style={styles.spaced} value={category} options={NEW_ITEM_DEFAULTS.categories} onChange={setCategory} />
        <Select label="Unit" style={styles.spaced} value={unit} options={NEW_ITEM_DEFAULTS.units} onChange={setUnit} />
      </Card>

      <Card title="Tax">
        <View style={styles.pair}>
          <Field label="HSN" style={styles.flex} value={hsn} onChangeText={setHsn} keyboardType="number-pad" />
          <Field
            label="GST %"
            style={styles.flex}
            value={gst}
            onChangeText={(v) => setGst(v.replace(/[^0-9.]/g, ''))}
            keyboardType="decimal-pad"
          />
        </View>
      </Card>

      <Card title="Rates">
        <View style={styles.pair}>
          <Field
            label="Purchase cost"
            style={styles.flex}
            value={cost}
            onChangeText={(v) => setCost(v.replace(/[^0-9.]/g, ''))}
            keyboardType="decimal-pad"
            hint="For the margin check only"
          />
          <Field
            label="Selling rate"
            required
            style={styles.flex}
            value={sale}
            onChangeText={(v) => setSale(v.replace(/[^0-9.]/g, ''))}
            keyboardType="decimal-pad"
            error={errors.sale}
          />
        </View>

        {margin !== null ? (
          <AppText size="xs" color={inverted ? COLORS.error : COLORS.success} style={styles.margin}>
            {inverted
              ? `Selling rate is below cost by ${rupees(costNum - saleNum)}`
              : `Margin ${margin.toFixed(1)}% · ${rupees(saleNum - costNum)} per ${unit}`}
          </AppText>
        ) : null}
      </Card>

      {inverted ? (
        <NoticeBar tone="danger">
          Selling rate is below purchase cost. Every sale of this item books a loss.
        </NoticeBar>
      ) : (
        <NoticeBar tone="info" glyph="📦">
          Stock arrives through a purchase, never typed here — the quantity is a cache of the ledger.
        </NoticeBar>
      )}
    </Screen>
  );
}

