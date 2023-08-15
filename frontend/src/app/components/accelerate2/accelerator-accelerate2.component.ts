import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription, catchError, debounceTime, of, tap } from 'rxjs';
import { Recommendedfees } from '../../interfaces/websocket.interface';
import { WebsocketService } from '../../services/websocket.service';
import { ServicesApiService } from '../../../../../services/src/app/services/services-api.service';
import { StateService } from '../../services/state.service';

export const DEFAULT_BID_RATIO = 5;
export const MIN_BID_RATIO = 2;
export const MAX_BID_RATIO = 20;

export type AccelerationStatus = 'requested' | 'accelerating' | 'mined' | 'completed' | 'failed';
export interface AccelerationEstimate {
  txSummary: TxSummary;
  nextBlockFee: number;
  targetFeeRate: number;
  userBalance: number;
  enoughBalance: boolean;
  cost: number; // Override by frontend
  mempoolBaseFee: number;
  vsizeFee: number;
}
export interface TxSummary {
  txid: string; // txid of the current transaction
  effectiveVsize: number; // Total vsize of the dependency tree
  effectiveFee: number;  // Total fee of the dependency tree in sats
  ancestorCount: number; // Number of ancestors
}

@Component({
  selector: 'app-accelerator-accelerate2',
  templateUrl: './accelerator-accelerate2.component.html',
  styleUrls: ['./accelerator-accelerate2.component.scss'],
})
export class AcceleratorAccelerate2 implements OnInit, OnDestroy {
  math = Math;
  parseint = parseInt;

  showSuccess = false;
  loading = true;
  error = '';
  tab: 'txid' | 'rawtx' = 'txid';
  mode: 'simple' | 'advanced' = 'advanced';
  form: FormGroup;
  paramMapSubscription: Subscription;
  txidChangeSubscription$: Subscription | undefined;
  accelerationSubscription$: Subscription;
  estimateSubscription$: Subscription;
  recommendedFeeSubscription$: Subscription;
  userBidSubscription$: Subscription | undefined;
  lastNextBlockFee: number;
  lastTxInput: string;

  fees: Recommendedfees | undefined;
  estimate: AccelerationEstimate | undefined;

  minExtraCost = 0;
  minBidAllowed = 0;
  maxBidAllowed = 0;
  defaultBid = 0;
  maxCost = 0;

  mempoolWidth: number = 1000;
  mempoolPositionSubscription$: Subscription;

  constructor(
    private mempoolWebsocket: WebsocketService,
    private formBuilder: FormBuilder,
    private activatedRoute: ActivatedRoute,
    private servicesApiService: ServicesApiService,
    private mempoolStateService: StateService,
  ) {
  }

  ngOnDestroy(): void {
    if (this.paramMapSubscription) {
      this.paramMapSubscription.unsubscribe();
    }
    if (this.txidChangeSubscription$) {
      this.txidChangeSubscription$.unsubscribe();
    }
    if (this.estimateSubscription$) {
      this.estimateSubscription$.unsubscribe();
    }
    if (this.recommendedFeeSubscription$) {
      this.recommendedFeeSubscription$.unsubscribe();
    }
    if (this.userBidSubscription$) {
      this.userBidSubscription$.unsubscribe();
    }
    if (this.mempoolPositionSubscription$) {
      this.mempoolPositionSubscription$.unsubscribe();
    }
  }

  ngOnInit(): void {
    this.onResize();

    this.form = this.formBuilder.group({
      'txInput': ['', Validators.required],
      'userBid': [0, Validators.required],
    });

    this.mempoolWebsocket.want(['stats']);

    this.servicesApiService.hasAccessToAccelerator$()
      .subscribe({
        error: (error) => {
          if (error.error === 'not_available') {
            this.error = 'waitlisted';
          } else {
            this.error = error.error;
          }
          this.loading = false;
        },
        next: () => {
          this.loading = false;

          // Get user balance
          this.txidChangeSubscription$ = this.form.get('txInput')?.valueChanges.pipe(
            debounceTime(250),
            tap((txInput) => {
              if (this.lastTxInput === txInput) {
                return;
              }
              this.lastTxInput = txInput;
              this.lastNextBlockFee = -1;
              this.error = '';
              this.showSuccess = false;
              if (!txInput) {
                this.estimate = undefined;
                this.mempoolWebsocket.stopTrackingTransaction();
                if (this.mempoolPositionSubscription$) {
                  this.mempoolPositionSubscription$.unsubscribe()
                  this.mempoolStateService.markBlock$.next({});
                }
                return;
              }
              this.loading = true;
              this.listenRecommendedFee(txInput);
              this.listenMaxBidChanges();
              this.mempoolPositionSubscription$ = this.mempoolStateService.mempoolTxPosition$.subscribe(txPosition => {
                if (txPosition && txPosition.position) {
                  this.mempoolStateService.markBlock$.next({
                    mempoolPosition: txPosition.position
                  });
                }
              });
              this.mempoolWebsocket.stopTrackingTransaction();
              this.mempoolWebsocket.startTrackTransaction(txInput);
            })
          ).subscribe();

          this.paramMapSubscription = this.activatedRoute.paramMap
            .pipe(
              tap((params) => {
                if (params['params']['id'] && this.tab === 'txid') {
                  this.form.controls['txInput'].setValue(params['params']['id']);
                }
              })
            ).subscribe();
        }
      })
  }

  /**
   * Listen to fee recommendation updates
   */
  listenRecommendedFee(txInput: string): void {
    if (this.recommendedFeeSubscription$) {
      this.recommendedFeeSubscription$.unsubscribe();
    }
    this.recommendedFeeSubscription$ = this.mempoolStateService.recommendedFees$.pipe(
      tap((stats) => {
        if (this.lastNextBlockFee === stats.fastestFee || this.showSuccess) {
          return;
        }
        this.lastNextBlockFee = stats.fastestFee;
        this.setupEstimationSubscription(txInput);
      })
    ).subscribe();
  }

  /**
   * Listen to max bid input changes
   */
  listenMaxBidChanges(): void {
    if (this.userBidSubscription$) {
      this.userBidSubscription$.unsubscribe();
    }
    this.userBidSubscription$ = this.form.get('userBid')?.valueChanges.pipe(
      tap((value) => {
        if (this.estimate) {
          this.maxCost = parseInt(value, 10) + this.estimate.mempoolBaseFee + this.estimate.vsizeFee;
        }
      })
    ).subscribe();
  }
  
  /**
   * Estimate acceleration cost for the next block and setup UI element accordingly
   */
  setupEstimationSubscription(txInput: string): void {
    if (this.estimateSubscription$) {
      this.estimateSubscription$.unsubscribe();
    }
    this.showSuccess = false;
    this.estimateSubscription$ = this.servicesApiService.estimate$(txInput).pipe(
      tap((response) => {
        this.loading = false;
        if (response.status === 204) {
          this.estimate = undefined;
          this.error = `cannot_accelerate_tx`;
          this.estimateSubscription$.unsubscribe();
        } else {
          this.estimate = response.body;
          if ((this.estimate?.userBalance ?? 0) <= 0) {
            this.error = `not_enough_balance`;
            this.estimateSubscription$.unsubscribe();
            return;
          }
          else if (this.estimate) {
            // Make min extra fee at least 50% of the current tx fee
            this.minExtraCost = Math.max(this.estimate.cost, this.estimate.txSummary.effectiveFee / 2);
            this.minExtraCost = Math.round(this.minExtraCost);

            this.minBidAllowed = this.minExtraCost * MIN_BID_RATIO;
            this.maxBidAllowed = Math.min(this.estimate.userBalance, this.minExtraCost * MAX_BID_RATIO);
            this.defaultBid = this.minExtraCost * DEFAULT_BID_RATIO;

            let userBid = parseInt(this.form.get('userBid')?.value, 10);
            if (!userBid) {
              this.form.get('userBid')?.setValue(this.defaultBid);
            } else if (userBid < this.minBidAllowed) {
              this.form.get('userBid')?.setValue(this.minBidAllowed);
            } else if (userBid > this.maxBidAllowed) {
              this.form.get('userBid')?.setValue(this.maxBidAllowed);
            }
            userBid = parseInt(this.form.get('userBid')?.value, 10);
            this.form.get('userBid')?.setValidators([Validators.required, Validators.min(this.minBidAllowed), Validators.max(this.maxBidAllowed)]);
            
            this.maxCost = userBid + this.estimate.mempoolBaseFee + this.estimate.vsizeFee;
          }
        }
      }),
      catchError((response) => {
        this.loading = false;
        this.estimate = undefined;
        this.error = response.error;
        this.estimateSubscription$.unsubscribe();
        return of(null);
      })
    ).subscribe();
  }

  /**
   * Send an acceleration request
   */
  accelerate(): void {
    this.showSuccess = false;
    if (!this.form.valid) {
      return;
    }
    if (this.accelerationSubscription$) {
      this.accelerationSubscription$.unsubscribe();
    }
    this.accelerationSubscription$ = this.servicesApiService.accelerate$(
      this.form.get('txInput')?.value,
      this.form.get('userBid')?.value
    ).subscribe({
      next: () => {
        this.showSuccess = true;
        this.estimateSubscription$.unsubscribe();
      },
      error: (response) => {
        this.error = response.error;
      }
    });
  }

  /**
   * Switch between input modes
   */
  switchTab(tab: 'txid' | 'rawtx') {
    this.tab = tab;
    this.error = '';
    this.estimate = undefined;
    this.form.controls['txInput'].setValue('');
    this.showSuccess = false;

    if (this.paramMapSubscription) {
      this.paramMapSubscription.unsubscribe();
    }
    this.paramMapSubscription = this.activatedRoute.queryParams
      .pipe(
        tap((params) => {
          if (params['txid'] && this.tab === 'txid') {
            this.form.controls['txInput'].setValue(params['txid']);
          }
        })
      ).subscribe();

    return false;
  }

  /**
   * User click on multiplier buttons
   */
  setUserBid(multiplier: number) {
    if (this.estimate) {
      const userBid = Math.max(0, this.minExtraCost * multiplier);
      this.form.get('userBid')?.setValue(userBid);
      this.maxCost = userBid + this.estimate.mempoolBaseFee + this.estimate.vsizeFee;
    }
  }

  changeMode(mode: 'simple' | 'advanced') {
    this.mode = mode;
  }

  /**
   * Form validation feedback
   */
  get txInput() { return this.form.get('txInput')!; }
  get invalid_txInput() {
    const txInput = this.form.get('txInput')!;
    return txInput.invalid && (txInput.dirty || txInput.touched);
  }
  get userBid() { return this.form.get('userBid')!; }
  get invalid_userBid() {
    const userBid = this.form.get('userBid')!;
    return userBid.invalid && (userBid.dirty || userBid.touched);
  }

  @HostListener('window:resize', ['$event'])
  onResize(): void {
    if (window.innerWidth >= 992) {
      this.mempoolWidth = Math.min(window.innerWidth - 370, 850);
    } else {
      this.mempoolWidth = window.innerWidth - 120;
    }
  }
}

