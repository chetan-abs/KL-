import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';

import { useThemeColors } from '../context/ThemeContext';
import { tabsFor, homeFor, titleFor } from '../constants/roles';
import { userCan } from '../utils/permissions';
import { useAuth } from '../context/AuthContext';
import { Alerts } from '../services/endpoints';

import LoginScreen from '../screens/mobile/LoginScreen';
import ForcePasswordScreen from '../screens/mobile/ForcePasswordScreen';
import OrderQueueScreen from '../screens/mobile/OrderQueueScreen';
import OrderReviewScreen from '../screens/mobile/OrderReviewScreen';
import OrderWindowScreen from '../screens/mobile/OrderWindowScreen';
import CommissionAgentScreen from '../screens/mobile/CommissionAgentScreen';
import NewAgentScreen from '../screens/mobile/NewAgentScreen';
import PickerScreen from '../screens/mobile/PickerScreen';
import VerifyScreen from '../screens/mobile/VerifyScreen';
import InvoiceScreen from '../screens/mobile/InvoiceScreen';
import DispatchSheetScreen from '../screens/mobile/DispatchSheetScreen';
import DriverRouteScreen from '../screens/mobile/DriverRouteScreen';
import DeliveryScreen from '../screens/mobile/DeliveryScreen';
import PurchaseScreen from '../screens/mobile/PurchaseScreen';
import RateAlertScreen from '../screens/mobile/RateAlertScreen';
import NewItemScreen from '../screens/mobile/NewItemScreen';
import SalesReturnScreen from '../screens/mobile/SalesReturnScreen';
import CreditNoteScreen from '../screens/mobile/CreditNoteScreen';
import SalesmanDashboardScreen from '../screens/mobile/SalesmanDashboardScreen';
import BeatPlanScreen from '../screens/mobile/BeatPlanScreen';
import CreateEstimateScreen from '../screens/mobile/CreateEstimateScreen';
import SchemeScreen from '../screens/mobile/SchemeScreen';
import NewDealerScreen from '../screens/mobile/NewDealerScreen';
import ChequeDepositScreen from '../screens/mobile/ChequeDepositScreen';
import YashDashboardScreen from '../screens/mobile/YashDashboardScreen';
import EodScreen from '../screens/mobile/EodScreen';
import StockCountScreen from '../screens/mobile/StockCountScreen';
import NotificationsScreen from '../screens/mobile/NotificationsScreen';
import WorkQueueScreen from '../screens/mobile/WorkQueueScreen';
import RegisterScreen from '../screens/mobile/RegisterScreen';
import DriverHistoryScreen from '../screens/mobile/DriverHistoryScreen';
import ProfileScreen from '../screens/mobile/ProfileScreen';
import AttendanceScreen from '../screens/mobile/AttendanceScreen';
import AttendanceRegisterScreen from '../screens/mobile/AttendanceRegisterScreen';
import NewEmployeeScreen from '../screens/mobile/NewEmployeeScreen';
import SalaryRegisterScreen from '../screens/mobile/SalaryRegisterScreen';
import ChangePasswordScreen from '../screens/mobile/ChangePasswordScreen';
import PasswordRequestsScreen from '../screens/mobile/PasswordRequestsScreen';
import ItemCatalogScreen from '../screens/mobile/ItemCatalogScreen';
import PeopleScreen from '../screens/mobile/PeopleScreen';
import SalaryScreen from '../screens/mobile/SalaryScreen';
import AdvancesScreen from '../screens/mobile/AdvancesScreen';
import IncentiveScreen from '../screens/mobile/IncentiveScreen';
import GitScreen from '../screens/mobile/GitScreen';
import TransfersScreen from '../screens/mobile/TransfersScreen';
import RateChangeScreen from '../screens/mobile/RateChangeScreen';
import HandoverScreen from '../screens/mobile/HandoverScreen';
import ReportsScreen from '../screens/mobile/ReportsScreen';
import TallyScreen from '../screens/mobile/TallyScreen';

/**
 * The phone app's navigation.
 *
 * A hand-rolled stack over a `useState` route rather than React Navigation. The
 * whole tree is one screen deep from a tab — queue → review, route → delivery —
 * and every screen already draws its own navy header with its own back link, so
 * a navigator would contribute a header we hide, a theme we override, and a
 * second source of truth for which tab is lit.
 *
 * `stack` is the push history. A tab press clears it, which is the behaviour a
 * tab bar promises: tapping Orders while three deep in an order returns to the
 * list, not to the middle of the last one.
 */

/** Screens that live inside a tab, and so keep the tab bar visible. */
const TAB_SCREENS = new Set([
  'orderQueue', 'register', 'notifications', 'profile', 'people', 'attendanceRegister', 'itemCatalog',
  'pickList', 'stockCount',
  'verifyList', 'dispatchSheet',
  'invoiceList', 'creditNote',
  'driverRoute', 'driverHistory',
  'purchase', 'rateAlert', 'newItem',
  'salesmanDashboard', 'beatPlan', 'createEstimate',
  'eod', 'chequeDeposit',
  'yashDashboard',
]);

export default function MobileNavigator() {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background,
  },
}), [COLORS]);
  const { status, user, signOut, mustChangePassword } = useAuth();
  const [stack, setStack] = React.useState([]);
  const [unread, setUnread] = React.useState(0);

  const tabs = React.useMemo(() => tabsFor(user), [user]);
  const current = stack.length ? stack[stack.length - 1] : null;

  const push = React.useCallback((route, params) => {
    setStack((prev) => [...prev, { route, params }]);
  }, []);

  const pop = React.useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const selectTab = React.useCallback((key) => setStack([{ route: key }]), []);

  // The signed-in account decides where the app opens, so the stack is seeded
  // when the session appears rather than at sign-in: a restored token brings a
  // user back without going through the login screen at all.
  React.useEffect(() => {
    if (status === 'signedIn' && user && !stack.length) {
      setStack([{ route: homeFor(user) }]);
    }
    if (status === 'signedOut' && stack.length) {
      setStack([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, user]);

  /**
   * The unread count on the Alerts tab.
   *
   * Refreshed whenever the route changes rather than on a timer: the badge only
   * has to be right when somebody is looking, and a poll on a field phone spends
   * battery to tell nobody.
   */
  const refreshUnread = React.useCallback(async () => {
    try {
      const { unread: count } = await Alerts.list({ unread: 1, limit: 1 });
      setUnread(count || 0);
    } catch {
      // A badge is not worth surfacing an error for; the Alerts screen itself
      // will say so properly when it is opened.
    }
  }, []);

  React.useEffect(() => {
    if (status === 'signedIn') refreshUnread();
  }, [status, current?.route, refreshUnread]);

  if (status === 'restoring') {
    return (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color={COLORS.brand} />
      </View>
    );
  }

  if (status !== 'signedIn' || !user) return <LoginScreen />;

  /**
   * An account still on the password a script gave it gets this and nothing
   * else (migration 015). Placed above the route switch rather than inside it
   * so there is no route, tab or deep link that reaches the app around it —
   * the server refuses those requests anyway, and a screen that renders only to
   * fill with 403s is worse than the gate.
   */
  if (mustChangePassword) return <ForcePasswordScreen />;

  if (!current) return <View style={styles.flex} />;

  /**
   * The role descriptor, plus the handful of "may I decide this" flags the
   * screens ask about.
   *
   * They live here rather than in each screen because every one of them mirrors
   * a predicate the server already owns — `managesPayroll` in `routes/payroll.js`,
   * `approvesRates` in `routes/items.js`, and so on — and eleven screens each
   * spelling out its own `userCan` call is eleven places for the client copy to
   * drift from the server's.
   *
   * None of them is a security boundary. Every route below is guarded; these
   * only decide whether a control is drawn, so that a picker is not shown an
   * Approve button that can only ever 403.
   */
  const role = {
    name: user.name,
    title: titleFor(user),
    key: user.id,
    // Yash or Manoj specifically, not "anyone who can approve" — Manas also
    // approves leave (leave.approve) but is still an employee who requests
    // his own, so this has to name the owner, not the wider approval grant.
    isOwner: userCan(user, 'all'),
    managesSalary: userCan(user, 'salary') || userCan(user, 'salary.manage'),
    approvesLeave: userCan(user, 'leave') || userCan(user, 'leave.approve'),
    approvesIncentives: userCan(user, 'incentives') || userCan(user, 'incentives.approve'),
    approvesRates: userCan(user, 'all'),
    movesGoods: userCan(user, 'purchases') || userCan(user, 'purchases.edit'),
    journalsTransfers: userCan(user, 'billing') || userCan(user, 'billing.create'),
    countsCash: userCan(user, 'cash') || userCan(user, 'cash.manage'),
    seesReports: userCan(user, 'reports') || userCan(user, 'reports.view') || userCan(user, 'all'),
    runsTally: userCan(user, 'all'),
    seesAttendanceRegister: userCan(user, 'attendance') || userCan(user, 'attendance.view'),
  };

  // Navigation is handed down as a descriptor, not a rendered bar: only
  // `Screen` knows whether the viewport wants a bottom tab bar or a sidebar,
  // and screens pass this straight through without caring which.
  //
  // `onTab` rides along rather than deciding here: on a phone a pushed screen
  // hides the bar, because a task the user is inside should not offer a tab
  // switch that abandons a half-filled form. On desktop the sidebar stays — the
  // room is there, the back link already handles focus, and a page with no
  // navigation at all reads as having lost its way.
  const nav = {
    tabs: tabs.map((tab) => (tab.key === 'notifications' ? { ...tab, badge: unread } : tab)),
    active: current.route,
    onSelect: selectTab,
    user,
    roleTitle: role.title,
    onTab: TAB_SCREENS.has(current.route),
  };

  const shared = { role, user, nav, onBack: pop, onSignOut: signOut, onRefreshBadge: refreshUnread };

  function render() {
    const { route, params } = current;

    switch (route) {
      // ---- Approval ------------------------------------------------------
      case 'orderQueue':
        return <OrderQueueScreen {...shared} onOpenOrder={(order) => push('orderReview', { order })} />;
      case 'orderReview':
        return (
          <OrderReviewScreen
            {...shared}
            order={params?.order}
            onSettled={() => selectTab('orderQueue')}
          />
        );
      case 'orderWindow':
        return <OrderWindowScreen {...shared} onSaved={() => pop()} />;
      case 'commissionAgent':
        return (
          <CommissionAgentScreen
            {...shared}
            order={params?.order}
            onAddAgent={() => push('newAgent')}
            onContinue={pop}
          />
        );
      case 'newAgent':
        return <NewAgentScreen {...shared} onSaved={pop} />;
      case 'register':
        return <RegisterScreen {...shared} />;

      // ---- Picking -------------------------------------------------------
      case 'pickList':
        return (
          <WorkQueueScreen
            {...shared}
            variant="pick"
            onOpen={(row) => push('picker', { orderId: row.order_id, party: row.party })}
          />
        );
      case 'picker':
        return (
          <PickerScreen
            {...shared}
            orderId={params?.orderId}
            party={params?.party}
            onHandover={() => selectTab('pickList')}
          />
        );
      case 'stockCount':
        return <StockCountScreen {...shared} />;

      // ---- Verification --------------------------------------------------
      case 'verifyList':
        return (
          <WorkQueueScreen
            {...shared}
            variant="verify"
            onOpen={(row) => push('verify', { orderId: row.order_id, party: row.party })}
          />
        );
      case 'verify':
        return (
          <VerifyScreen
            {...shared}
            orderId={params?.orderId}
            party={params?.party}
            onVerified={() => selectTab('verifyList')}
          />
        );
      case 'dispatchSheet':
        return <DispatchSheetScreen {...shared} />;

      // ---- Billing -------------------------------------------------------
      case 'invoiceList':
        return (
          <WorkQueueScreen
            {...shared}
            variant="invoice"
            onOpen={(row) => push('invoice', { orderId: row.order_id, party: row.party })}
          />
        );
      case 'invoice':
        return (
          <InvoiceScreen
            {...shared}
            orderId={params?.orderId}
            party={params?.party}
            onInvoiced={() => selectTab('invoiceList')}
          />
        );
      case 'creditNote':
        return <CreditNoteScreen {...shared} onNewReturn={() => push('salesReturn')} />;
      case 'salesReturn':
        return <SalesReturnScreen {...shared} onDone={pop} />;

      // ---- Delivery ------------------------------------------------------
      case 'driverRoute':
        return (
          <DriverRouteScreen
            {...shared}
            onOpenStop={(stop) => push('delivery', { stop })}
          />
        );
      case 'delivery':
        return (
          <DeliveryScreen {...shared} stop={params?.stop} onDone={() => selectTab('driverRoute')} />
        );
      case 'driverHistory':
        return <DriverHistoryScreen {...shared} />;

      // ---- Purchase ------------------------------------------------------
      case 'purchase':
        return (
          <PurchaseScreen
            {...shared}
            onNewItem={() => push('newItem')}
            onOpenGit={() => push('git')}
            onOpenTransfers={() => push('transfers')}
          />
        );
      case 'git':
        return <GitScreen {...shared} />;
      case 'transfers':
        return <TransfersScreen {...shared} />;
      case 'rateAlert':
        return <RateAlertScreen {...shared} />;
      case 'newItem':
        return <NewItemScreen {...shared} />;

      // ---- Field sales ---------------------------------------------------
      case 'salesmanDashboard':
        return (
          <SalesmanDashboardScreen
            {...shared}
            onNewOrder={() => push('orderWindow')}
            onNewDealer={() => push('newDealer')}
            onOpenScheme={() => push('scheme')}
            onOpenHandover={() => push('handover')}
          />
        );
      case 'beatPlan':
        return <BeatPlanScreen {...shared} />;
      case 'createEstimate':
        return <CreateEstimateScreen {...shared} onConverted={() => push('orderWindow')} />;
      case 'newDealer':
        return <NewDealerScreen {...shared} onSaved={pop} />;
      case 'scheme':
        return <SchemeScreen {...shared} />;

      // ---- Cash ----------------------------------------------------------
      case 'eod':
        return <EodScreen {...shared} onOpenHandover={() => push('handover')} />;
      case 'chequeDeposit':
        return <ChequeDepositScreen {...shared} />;
      case 'handover':
        return <HandoverScreen {...shared} />;

      // ---- Owner ---------------------------------------------------------
      case 'yashDashboard':
        return (
          <YashDashboardScreen
            {...shared}
            onOpenOrders={() => selectTab('orderQueue')}
            onOpenReports={() => push('reports')}
            onOpenRateChanges={() => push('rateChanges')}
            onOpenTally={() => push('tally')}
            onOpenAttendanceRegister={role.seesAttendanceRegister ? () => push('attendanceRegister') : null}
            onOpenSalaryRegister={role.managesSalary ? () => push('salaryRegister') : null}
          />
        );
      case 'attendanceRegister':
        return <AttendanceRegisterScreen {...shared} />;
      case 'people':
        return <PeopleScreen {...shared} onNewEmployee={() => push('newEmployee')} />;
      case 'itemCatalog':
        return <ItemCatalogScreen {...shared} />;
      case 'newEmployee':
        return <NewEmployeeScreen {...shared} onSaved={() => selectTab('people')} />;
      case 'reports':
        return <ReportsScreen {...shared} />;
      case 'rateChanges':
        return <RateChangeScreen {...shared} />;
      case 'tally':
        return <TallyScreen {...shared} />;

      // ---- Everyone ------------------------------------------------------
      case 'notifications':
        return <NotificationsScreen {...shared} />;
      case 'profile':
        return (
          <ProfileScreen
            {...shared}
            onOpenPeople={() => push('people')}
            onOpenSalary={() => push('salary')}
            onOpenAdvances={() => push('advances')}
            onOpenIncentive={() => push('incentive')}
            onOpenAttendance={() => push('attendance')}
            onOpenChangePassword={() => push('changePassword')}
            onOpenPasswordRequests={
              userCan(user, 'employees.permissions') ? () => push('passwordRequests') : null
            }
          />
        );
      case 'attendance':
        return <AttendanceScreen {...shared} />;
      case 'changePassword':
        return <ChangePasswordScreen {...shared} />;
      case 'passwordRequests':
        return <PasswordRequestsScreen {...shared} />;

      // Everybody's own pay, reached from Profile. `params.from` is what turns
      // on the back link — the same screens are opened without it from a
      // register, where the tab bar is the way back.
      case 'salary':
        return <SalaryScreen {...shared} params={{ from: 'profile', ...params }} />;
      case 'salaryRegister':
        return (
          <SalaryRegisterScreen
            {...shared}
            onOpenEmployee={(p) => push('salary', { ...p, backLabel: 'Salary Register' })}
          />
        );
      case 'advances':
        return <AdvancesScreen {...shared} />;
      case 'incentive':
        return <IncentiveScreen {...shared} params={{ ...params, from: 'profile' }} />;

      default:
        return <NotificationsScreen {...shared} />;
    }
  }

  return <View style={styles.flex}>{render()}</View>;
}

