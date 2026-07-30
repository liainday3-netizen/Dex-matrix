//+------------------------------------------------------------------+
//|                             IronHawk_Microstructure_Matrix.mq5   |
//|                            Advanced Quantitative Trading Systems |
//|                                   Version 5.1.0 - Visual Quant   |
//+------------------------------------------------------------------+
#property copyright "IronHawk Capital Quant Team"
#property link      "https://www.mql5.com"
#property version   "5.10"
#property description "Institutional Multi-Asset Quant Scanner with Visual Projection."

#property indicator_chart_window
#property indicator_buffers 0
#property indicator_plots   0

//====================================================================
// [1] ADVANCED INPUT PARAMETERS
//====================================================================
input group "--- SCANNER SETTINGS ---"
input string         InpSymbols           = "EURUSD,GBPUSD,USDJPY,USDCHF,AUDUSD"; // Modified for MQL5 Validation
input ENUM_TIMEFRAMES InpHTF              = PERIOD_H4;     
input ENUM_TIMEFRAMES InpLTF              = PERIOD_M15;    

input group "--- QUANTITATIVE FILTERS ---"
input int            InpHistoryBars       = 200;           
input double         InpVolumeZScore      = 1.5;           

input group "--- VISUALS (CURRENT CHART) ---"
input bool           InpDrawOB            = true;          // Draw OB Zones on Current Chart
input color          InpColorBullOB       = clrDarkGreen;  // Bullish POI Color
input color          InpColorBearOB       = clrMaroon;     // Bearish POI Color

input group "--- DAILY BIAS & SESSIONS ---"
input bool           InpUseDailyBias      = true;          
input color          InpColorBias         = clrMediumPurple; 
input bool           InpUseKillzones      = true;          
input int            InpLondonStart       = 8;             
input int            InpLondonEnd         = 12;
input int            InpNYStart           = 13;            
input int            InpNYEnd             = 17;

input group "--- ALERTS & UI ---"
input bool           InpAlertPush         = true;          
input bool           InpAlertPopup        = true;          
input color          InpColorBg           = C'11,15,25';    // IronHawk Dark
input color          InpColorHeader       = C'212,175,55';  // IronHawk Gold
input color          InpColorText         = clrWhite;      
input color          InpColorBull         = C'34,197,94';   // Bull Green
input color          InpColorBear         = C'239,68,68';   // Bear Red
input color          InpColorWait         = C'100,116,139'; // Slate

//====================================================================
// [2] DATA STRUCTURES & CACHING
//====================================================================
enum ENUM_MARKET_STATE
  {
   STATE_WAITING,         
   STATE_FILTERED_BIAS,   
   STATE_OUT_OF_SESSION,  
   STATE_SYNC_ERROR,      
   STATE_IN_HTF_POI,      
   STATE_BULL_EXEC,       
   STATE_BEAR_EXEC        
  };

struct SAssetStatus
  {
   string            symbol;          
   ENUM_MARKET_STATE state;           
   ENUM_MARKET_STATE prev_state;      
   string            ltf_message;     
   // CPU Caching System
   datetime          last_htf_time;   
   double            cached_ob_high;
   double            cached_ob_low;
   datetime          cached_ob_time;  // Start time of the OB for visual drawing
   int               cached_ob_type;  // 1 = Bull, -1 = Bear, 0 = None
  };

//====================================================================
// [3] GRAPHICAL USER INTERFACE (GUI) ENGINE
//====================================================================
class CGUIManager
  {
private:
   string m_prefix;
   int    m_x_offset;
   int    m_y_offset;
   int    m_row_height;

public:
                     CGUIManager() : m_prefix("IH_DASH_"), m_x_offset(30), m_y_offset(30), m_row_height(25) {}
                    ~CGUIManager() { ObjectsDeleteAll(0, m_prefix); ChartRedraw(); }

   void              BuildBase(string &symbols[], int count)
     {
      ObjectsDeleteAll(0, m_prefix);

      int bg_width = 620;
      int bg_height = 80 + (count * m_row_height);
      CreateRect(m_prefix + "BG", m_x_offset, m_y_offset, bg_width, bg_height, InpColorBg, C'30,41,59');

      CreateLabel(m_prefix + "TITLE", "IRONHAWK CAPITAL", m_x_offset + 15, m_y_offset + 15, InpColorHeader, 12, "Playfair Display", true);
      CreateLabel(m_prefix + "SUBTITLE", "PRO MICROSTRUCTURE MATRIX v5.1 | VISUAL ENGINE", m_x_offset + 15, m_y_offset + 35, clrGray, 8, "Consolas");

      int y_headers = m_y_offset + 60;
      CreateLabel(m_prefix + "H_SYM", "ASSET", m_x_offset + 15, y_headers, InpColorHeader, 9, "Consolas");
      CreateLabel(m_prefix + "H_HTF", "HTF CACHE", m_x_offset + 100, y_headers, InpColorHeader, 9, "Consolas");
      CreateLabel(m_prefix + "H_LTF", "FRACTAL LOGIC", m_x_offset + 300, y_headers, InpColorHeader, 9, "Consolas");
      CreateLabel(m_prefix + "H_ACT", "SIGNAL", m_x_offset + 480, y_headers, InpColorHeader, 9, "Consolas");

      for(int i = 0; i < count; i++)
        {
         int y_row = y_headers + 20 + (i * m_row_height);
         CreateLabel(m_prefix + "SYM_" + IntegerToString(i), symbols[i], m_x_offset + 15, y_row, InpColorText, 9, "Consolas", true);
         CreateLabel(m_prefix + "HTF_" + IntegerToString(i), "Loading...", m_x_offset + 100, y_row, InpColorWait, 9, "Consolas");
         CreateLabel(m_prefix + "LTF_" + IntegerToString(i), "---", m_x_offset + 300, y_row, InpColorWait, 9, "Consolas");
         CreateLabel(m_prefix + "ACT_" + IntegerToString(i), "SEARCHING", m_x_offset + 480, y_row, InpColorWait, 9, "Consolas", true);
        }
      ChartRedraw();
     }

   void              UpdateRow(int index, SAssetStatus &status)
     {
      string htf_text = "OUTSIDE POI"; color htf_color = InpColorWait;
      string act_text = "WAITING"; color act_color = InpColorWait;

      switch(status.state)
        {
         case STATE_SYNC_ERROR: htf_text = "DATA SYNC ERROR"; htf_color = clrDimGray; act_text = "AWAITING TICKS"; act_color = clrDimGray; break;
         case STATE_FILTERED_BIAS: htf_text = "IGNORED (D1 BIAS)"; htf_color = InpColorBias; act_text = "D1 FILTERED"; act_color = clrGray; break;
         case STATE_OUT_OF_SESSION: htf_text = "INSIDE POI (CACHED)"; htf_color = InpColorHeader; act_text = "OUT OF KILLZONE"; act_color = clrGray; break;
         case STATE_IN_HTF_POI: htf_text = "INSIDE POI (CACHED)"; htf_color = InpColorHeader; act_text = "MONITOR LTF"; act_color = InpColorHeader; break;
         case STATE_BULL_EXEC: htf_text = "HTF BULLISH"; htf_color = InpColorBull; act_text = "EXECUTE BUY"; act_color = InpColorBull; break;
         case STATE_BEAR_EXEC: htf_text = "HTF BEARISH"; htf_color = InpColorBear; act_text = "EXECUTE SELL"; act_color = InpColorBear; break;
        }

      string idx_str = IntegerToString(index);
      ObjectSetString(0, m_prefix + "HTF_" + idx_str, OBJPROP_TEXT, htf_text);
      ObjectSetInteger(0, m_prefix + "HTF_" + idx_str, OBJPROP_COLOR, htf_color);
      ObjectSetString(0, m_prefix + "LTF_" + idx_str, OBJPROP_TEXT, status.ltf_message);
      ObjectSetInteger(0, m_prefix + "LTF_" + idx_str, OBJPROP_COLOR, htf_color);
      ObjectSetString(0, m_prefix + "ACT_" + idx_str, OBJPROP_TEXT, act_text);
      ObjectSetInteger(0, m_prefix + "ACT_" + idx_str, OBJPROP_COLOR, act_color);
     }

private:
   void              CreateRect(string name, int x, int y, int w, int h, color bg, color border)
     {
      ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x); ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
      ObjectSetInteger(0, name, OBJPROP_XSIZE, w); ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
      ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bg); ObjectSetInteger(0, name, OBJPROP_COLOR, border);
      ObjectSetInteger(0, name, OBJPROP_BORDER_TYPE, BORDER_FLAT);
     }

   void              CreateLabel(string name, string text, int x, int y, color clr, int size, string font, bool bold = false)
     {
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x); ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
      ObjectSetString(0, name, OBJPROP_TEXT, text); ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, size); ObjectSetString(0, name, OBJPROP_FONT, font);
     }
  };

//====================================================================
// [4] QUANTITATIVE ENGINE (Logic & Visual Rendering)
//====================================================================
class CMatrixEngine
  {
private:
   string            m_symbols[];
   SAssetStatus      m_status[];
   int               m_symbol_count;
   CGUIManager       *m_gui;

public:
                     CMatrixEngine() : m_symbol_count(0), m_gui(NULL) {}
                    ~CMatrixEngine() { if(m_gui != NULL) delete m_gui; ObjectDelete(0, "IH_OB_VISUAL"); }

   bool              Initialize()
     {
      ushort separator = StringGetCharacter(",", 0);
      StringSplit(InpSymbols, separator, m_symbols);
      m_symbol_count = ArraySize(m_symbols);

      if(m_symbol_count == 0) return false;

      ArrayResize(m_status, m_symbol_count);
      for(int i = 0; i < m_symbol_count; i++)
        {
         StringTrimLeft(m_symbols[i]); StringTrimRight(m_symbols[i]);
         SymbolSelect(m_symbols[i], true);
         m_status[i].symbol = m_symbols[i];
         m_status[i].state = STATE_WAITING;
         m_status[i].prev_state = STATE_WAITING;
         m_status[i].last_htf_time = 0;
         m_status[i].cached_ob_type = 0;
        }

      m_gui = new CGUIManager();
      m_gui.BuildBase(m_symbols, m_symbol_count);
      EventSetTimer(1); 
      return true;
     }

   void              RunScanCycle()
     {
      for(int i = 0; i < m_symbol_count; i++) 
        { 
         AnalyzeSymbol(i); 
         m_gui.UpdateRow(i, m_status[i]); 
         CheckAlerts(i); 
         DrawVisuals(i);
        }
      ChartRedraw();
     }

private:
   void              DrawVisuals(int index)
     {
      if(!InpDrawOB) return;
      
      if(m_status[index].symbol != _Symbol) return; 

      string ob_name = "IH_OB_VISUAL";
      
      if(m_status[index].cached_ob_type == 0)
        {
         ObjectDelete(0, ob_name);
         return;
        }

      color ob_color = (m_status[index].cached_ob_type == 1) ? InpColorBullOB : InpColorBearOB;
      datetime time_future = TimeCurrent() + PeriodSeconds(InpHTF) * 5; 

      if(ObjectFind(0, ob_name) < 0)
        {
         ObjectCreate(0, ob_name, OBJ_RECTANGLE, 0, m_status[index].cached_ob_time, m_status[index].cached_ob_high, time_future, m_status[index].cached_ob_low);
         ObjectSetInteger(0, ob_name, OBJPROP_COLOR, ob_color);
         ObjectSetInteger(0, ob_name, OBJPROP_BGCOLOR, ob_color);
         ObjectSetInteger(0, ob_name, OBJPROP_BACK, true); 
         ObjectSetInteger(0, ob_name, OBJPROP_FILL, true); 
        }
      else
        {
         ObjectSetInteger(0, ob_name, OBJPROP_TIME, 0, m_status[index].cached_ob_time);
         ObjectSetDouble(0, ob_name, OBJPROP_PRICE, 0, m_status[index].cached_ob_high);
         ObjectSetInteger(0, ob_name, OBJPROP_TIME, 1, time_future);
         ObjectSetDouble(0, ob_name, OBJPROP_PRICE, 1, m_status[index].cached_ob_low);
         ObjectSetInteger(0, ob_name, OBJPROP_COLOR, ob_color);
         ObjectSetInteger(0, ob_name, OBJPROP_BGCOLOR, ob_color);
        }
     }

   void              CheckAlerts(int index)
     {
      if(m_status[index].state != m_status[index].prev_state && (m_status[index].state == STATE_BULL_EXEC || m_status[index].state == STATE_BEAR_EXEC))
        {
         string dir = (m_status[index].state == STATE_BULL_EXEC) ? "BUY" : "SELL";
         string msg = "IRONHAWK QUANTITATIVE MATRIX: " + dir + " ALIGNED ON " + m_status[index].symbol;
         if(InpAlertPush) SendNotification(msg);
         if(InpAlertPopup) Alert(msg);
        }
      m_status[index].prev_state = m_status[index].state;
     }

   void              AnalyzeSymbol(int index)
     {
      string sym = m_status[index].symbol;
      m_status[index].state = STATE_WAITING;
      m_status[index].ltf_message = "---";

      if(!SeriesInfoInteger(sym, InpHTF, SERIES_SYNCHRONIZED) || !SeriesInfoInteger(sym, InpLTF, SERIES_SYNCHRONIZED))
        { m_status[index].state = STATE_SYNC_ERROR; return; }

      datetime current_htf_time = (datetime)SeriesInfoInteger(sym, InpHTF, SERIES_LASTBAR_DATE);
      
      if(m_status[index].last_htf_time != current_htf_time)
        {
         m_status[index].cached_ob_type = 0;
         
         double htf_o[], htf_h[], htf_l[], htf_c[]; datetime htf_t[];
         ArraySetAsSeries(htf_o, true); ArraySetAsSeries(htf_h, true); ArraySetAsSeries(htf_l, true); ArraySetAsSeries(htf_c, true); ArraySetAsSeries(htf_t, true);
         
         if(CopyOpen(sym, InpHTF, 0, InpHistoryBars, htf_o) <= 0) return;
         CopyHigh(sym, InpHTF, 0, InpHistoryBars, htf_h); CopyLow(sym, InpHTF, 0, InpHistoryBars, htf_l); 
         CopyClose(sym, InpHTF, 0, InpHistoryBars, htf_c); CopyTime(sym, InpHTF, 0, InpHistoryBars, htf_t);
         
         for(int i = 2; i < InpHistoryBars - 2; i++)
           {
            if(htf_c[i+1] < htf_o[i+1] && htf_c[i] > htf_o[i] && htf_c[i] > htf_h[i+1]) 
              {
               if(htf_l[i-1] > htf_h[i+1]) 
                 {
                  m_status[index].cached_ob_type = 1;
                  m_status[index].cached_ob_high = htf_h[i+1];
                  m_status[index].cached_ob_low = htf_l[i+1];
                  m_status[index].cached_ob_time = htf_t[i+1];
                  break;
                 }
              }
            if(htf_c[i+1] > htf_o[i+1] && htf_c[i] < htf_o[i] && htf_c[i] < htf_l[i+1]) 
              {
               if(htf_h[i-1] < htf_l[i+1]) 
                 {
                  m_status[index].cached_ob_type = -1;
                  m_status[index].cached_ob_high = htf_h[i+1];
                  m_status[index].cached_ob_low = htf_l[i+1];
                  m_status[index].cached_ob_time = htf_t[i+1];
                  break;
                 }
              }
           }
         m_status[index].last_htf_time = current_htf_time; 
        }

      if(m_status[index].cached_ob_type == 0) return;
      double current_price = SymbolInfoDouble(sym, SYMBOL_BID);
      
      bool in_bull_ob = (m_status[index].cached_ob_type == 1 && current_price <= m_status[index].cached_ob_high && current_price >= m_status[index].cached_ob_low);
      bool in_bear_ob = (m_status[index].cached_ob_type == -1 && current_price <= m_status[index].cached_ob_high && current_price >= m_status[index].cached_ob_low);

      if(!in_bull_ob && !in_bear_ob) return; 

      int daily_bias = 0; 
      if(InpUseDailyBias)
        {
         double d_o[], d_c[];
         if(CopyOpen(sym, PERIOD_D1, 1, 1, d_o) > 0 && CopyClose(sym, PERIOD_D1, 1, 1, d_c) > 0)
           { if(d_c[0] > d_o[0]) daily_bias = 1; else if(d_c[0] < d_o[0]) daily_bias = -1; }
        }
        
      if((in_bull_ob && daily_bias == -1) || (in_bear_ob && daily_bias == 1))
        { m_status[index].state = STATE_FILTERED_BIAS; return; }

      m_status[index].state = STATE_IN_HTF_POI;

      if(InpUseKillzones)
        {
         MqlDateTime tm; TimeToStruct(TimeCurrent(), tm);
         if(!((tm.hour >= InpLondonStart && tm.hour <= InpLondonEnd) || (tm.hour >= InpNYStart && tm.hour <= InpNYEnd)))
           { m_status[index].state = STATE_OUT_OF_SESSION; m_status[index].ltf_message = "WAITING FOR SESSION"; return; }
        }

      double ltf_h[], ltf_l[], ltf_c[]; long ltf_v[];
      ArraySetAsSeries(ltf_h, true); ArraySetAsSeries(ltf_l, true); ArraySetAsSeries(ltf_c, true); ArraySetAsSeries(ltf_v, true);
      CopyHigh(sym, InpLTF, 0, 50, ltf_h); CopyLow(sym, InpLTF, 0, 50, ltf_l); CopyClose(sym, InpLTF, 0, 50, ltf_c); CopyTickVolume(sym, InpLTF, 0, 50, ltf_v);
      
      double vol_sum = 0; for(int v = 1; v <= 49; v++) vol_sum += (double)ltf_v[v];
      double vol_mean = vol_sum / 49.0;
      double variance_sum = 0; for(int v = 1; v <= 49; v++) variance_sum += MathPow((double)ltf_v[v] - vol_mean, 2);
      double std_dev = MathSqrt(variance_sum / 49.0);
      double vol_threshold = vol_mean + (InpVolumeZScore * std_dev);

      double recent_swing_high = ltf_h[ArrayMaximum(ltf_h, 2, 10)]; 
      double recent_swing_low = ltf_l[ArrayMinimum(ltf_l, 2, 10)];  
      
      for(int j = 2; j < 20; j++) { if(ltf_h[j] > ltf_h[j+1] && ltf_h[j] > ltf_h[j-1]) { recent_swing_high = ltf_h[j]; break; } }
      for(int j = 2; j < 20; j++) { if(ltf_l[j] < ltf_l[j+1] && ltf_l[j] < ltf_l[j-1]) { recent_swing_low = ltf_l[j]; break; } }

      if(in_bull_ob)
        {
         if(ltf_c[1] > recent_swing_high && (double)ltf_v[1] > vol_threshold)
           { m_status[index].state = STATE_BULL_EXEC; m_status[index].ltf_message = "FRACTAL CHOCH UP (Z-SCORE MET)"; }
         else if(ltf_c[1] > recent_swing_high) { m_status[index].ltf_message = "FRACTAL BREAK (LOW VOLUME)"; }
         else { m_status[index].ltf_message = "WAITING FRACTAL CHOCH"; }
        }
        
      if(in_bear_ob)
        {
         if(ltf_c[1] < recent_swing_low && (double)ltf_v[1] > vol_threshold)
           { m_status[index].state = STATE_BEAR_EXEC; m_status[index].ltf_message = "FRACTAL CHOCH DOWN (Z-SCORE MET)"; }
         else if(ltf_c[1] < recent_swing_low) { m_status[index].ltf_message = "FRACTAL BREAK (LOW VOLUME)"; }
         else { m_status[index].ltf_message = "WAITING FRACTAL CHOCH"; }
        }
     }
  };

//====================================================================
// [5] MAIN PROGRAM EXECUTION
//====================================================================
CMatrixEngine *Scanner;

int OnInit()
  {
   IndicatorSetString(INDICATOR_SHORTNAME, "IronHawk Microstructure Apex (Visual)");
   Scanner = new CMatrixEngine();
   if(!Scanner.Initialize()) { Print("Init Failed."); return INIT_FAILED; }
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { if(Scanner != NULL) delete Scanner; }
int OnCalculate(const int r, const int p, const datetime &t[], const double &o[], const double &h[], const double &l[], const double &c[], const long &tv[], const long &v[], const int &s[]) { return(r); }
void OnTimer() { if(Scanner != NULL) Scanner.RunScanCycle(); }
//+------------------------------------------------------------------+